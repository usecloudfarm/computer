//! `curl`, and the suspend/resume that lets a synchronous interpreter wait on
//! an asynchronous host.
//!
//! The shell evaluates synchronously from top to bottom; a `fetch` on the host
//! is a promise. Nothing in wasm can block an isolate waiting for one —
//! Cloudflare Workers forbids it outright — so the usual trick of
//! `Atomics.wait` on a worker thread is not available.
//!
//! Instead the run is restartable. When `curl` needs a response it does not
//! have, it records the request and aborts the script through the same fatal
//! path a limit uses. The caller restores the filesystem, performs the fetch,
//! files the response, and runs the script again from the top. The replay
//! reaches the same `curl`, finds the response waiting, and carries on to the
//! next one.
//!
//! What that costs: a script with n requests is executed n+1 times. Each
//! replay is local work with no network in it, and the filesystem is rolled
//! back between attempts, so the only lasting effect is the output of the run
//! that finally completes. What it requires is that the script be
//! deterministic up to each request — the same input has to produce the same
//! sequence of URLs — which is why `date` is a fixed string and the random
//! sources here are seeded rather than sampled.
//!
//! Each request is issued exactly once: replays are served from the record,
//! so a `curl -X POST` is not repeated.

use crate::commands::{parse_args, CmdOut, Ctx};

/// What the host is asked to fetch.
#[derive(Clone, Debug, Default)]
pub struct NetRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// What came back. An error is a value too: `curl` reports it and exits
/// non-zero rather than taking the shell down.
#[derive(Clone, Debug)]
pub struct NetResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub error: Option<String>,
}

/// The record of this run's requests, and the one still outstanding.
#[derive(Default)]
pub struct Net {
    /// Off unless the host wires a fetch in. `curl` is then absent entirely,
    /// which is what `just-bash` does and for the same reason: a shell that
    /// can reach the network is a different security proposition.
    pub enabled: bool,
    /// Responses already obtained, in request order.
    pub responses: Vec<NetResponse>,
    /// How far this attempt has got through them.
    pub cursor: usize,
    /// Set when a request has no response yet; the caller picks it up.
    pub pending: Option<NetRequest>,
}

impl Net {
    /// Called at the start of each attempt: the record survives, the position
    /// in it does not.
    pub fn rewind(&mut self) {
        self.cursor = 0;
        self.pending = None;
    }

    pub fn fulfil(&mut self, response: NetResponse) {
        self.responses.push(response);
    }

    /// The response for the next request, if this attempt has already got
    /// that far. Otherwise records what is wanted and answers None, which is
    /// the signal to unwind.
    pub fn take_next(&mut self, request: &NetRequest) -> Option<NetResponse> {
        if let Some(response) = self.responses.get(self.cursor) {
            self.cursor += 1;
            return Some(response.clone());
        }
        self.pending = Some(request.clone());
        None
    }
}

/// The sentinel that unwinds a run. It never reaches the user: the caller
/// checks `net.pending` first and only surfaces `fatal` when it is something
/// else.
pub const SUSPEND: &str = "__cloudfarm_fetch__";

pub fn curl(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let mut out = CmdOut::default();
    let a = parse_args(args, "XHdoAeu");

    let positional = a.positional();
    let Some(url) = positional.first() else {
        out.err("curl", "no URL specified");
        out.code = 2;
        return out;
    };

    let mut request = NetRequest {
        url: url.clone(),
        method: a.val('X').unwrap_or("GET").to_uppercase(),
        headers: vec![],
        body: None,
    };
    for header in a.vals('H') {
        if let Some((k, v)) = header.split_once(':') {
            request.headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    if let Some(body) = a.val('d') {
        request.body = Some(body.to_string());
        if a.val('X').is_none() { request.method = "POST".into(); }
        if !request.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
            request
                .headers
                .push(("content-type".into(), "application/x-www-form-urlencoded".into()));
        }
    }
    if let Some(agent) = a.val('A') {
        request.headers.push(("user-agent".into(), agent.to_string()));
    }

    let response = match ctx.net.take_next(&request) {
        Some(r) => r,
        None => {
            // No response yet. Record the request and unwind; the caller will
            // fetch it and run the script again.
            return CmdOut::default();
        }
    };

    if let Some(message) = &response.error {
        out.err("curl", message);
        // 7 is curl's "failed to connect", which scripts check for.
        out.code = 7;
        return out;
    }

    let include_headers = a.has('i') || a.has_long("include");
    let head_only = a.has('I') || a.has_long("head");
    let fail_on_error = a.has('f') || a.has_long("fail");

    if fail_on_error && response.status >= 400 {
        out.err("curl", &format!("The requested URL returned error: {}", response.status));
        out.code = 22;
        return out;
    }

    let mut body = String::new();
    if include_headers || head_only {
        body.push_str(&format!("HTTP/1.1 {}\r\n", response.status));
        for (k, v) in &response.headers {
            body.push_str(&format!("{}: {}\r\n", k, v));
        }
        body.push_str("\r\n");
    }
    if !head_only {
        body.push_str(&response.body);
    }

    // `-o file` writes instead of printing, as curl does.
    match a.val('o') {
        Some(path) if path != "-" => {
            let full = crate::fs::normalize(ctx.cwd, path);
            if let Err(e) = ctx.fs.write(&full, body.as_bytes(), false) {
                out.err("curl", &e);
                out.code = 23;
            }
        }
        _ => out.stdout.extend_from_slice(body.as_bytes()),
    }
    out
}

/// `wget -O- url`, enough of it to be useful, over the same machinery.
pub fn wget(args: &[String], ctx: &mut Ctx) -> CmdOut {
    let a = parse_args(args, "O");
    let mut forwarded: Vec<String> = vec![];
    if let Some(target) = a.val('O') {
        if target != "-" {
            forwarded.push("-o".into());
            forwarded.push(target.to_string());
        }
    } else if let Some(url) = a.positional().first() {
        // wget's default is to save under the last path segment.
        let name = url.rsplit('/').next().unwrap_or("index.html");
        let name = if name.is_empty() { "index.html" } else { name };
        forwarded.push("-o".into());
        forwarded.push(name.to_string());
    }
    forwarded.extend(a.positional());
    curl(&forwarded, ctx)
}
