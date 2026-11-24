//! rust-bash: a sandboxed bash interpreter with an in-memory filesystem,
//! built for AI agents and compiled to WebAssembly.

pub mod awk;
mod archive;
mod commands;
pub mod net;
mod sql;
mod structured;
mod coreutils;
pub mod fs;
pub mod interp;

pub use interp::{ExecResult, Limits, Shell};

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::cell::RefCell;
    use std::rc::Rc;

    use wasm_bindgen::prelude::*;

    use crate::net::{NetRequest, NetResponse};

    #[wasm_bindgen(getter_with_clone)]
    pub struct ExecOutput {
        pub stdout: String,
        pub stderr: String,
        #[wasm_bindgen(js_name = exitCode)]
        pub exit_code: i32,
    }

    #[wasm_bindgen]
    pub struct Bash {
        // Behind an `Rc<RefCell<…>>` because `execAsync` has to release its
        // borrow across every `await`: wasm-bindgen cannot hold `&mut self`
        // over a suspension point.
        sh: Rc<RefCell<crate::Shell>>,
        /// The host's fetch. Absent means no network, and no `curl`.
        fetch: Rc<RefCell<Option<js_sys::Function>>>,
    }

    #[wasm_bindgen]
    impl Bash {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Bash {
            Bash {
                sh: Rc::new(RefCell::new(crate::Shell::new())),
                fetch: Rc::new(RefCell::new(None)),
            }
        }

        /// Synchronous execution. `curl` is unavailable on this path — there
        /// is nowhere to await — so a script that reaches it gets
        /// "command not found" unless `execAsync` is used instead.
        pub fn exec(&mut self, script: &str) -> ExecOutput {
            let mut sh = self.sh.borrow_mut();
            sh.net.enabled = false;
            let r = sh.exec(script);
            ExecOutput { stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code }
        }

        /// Gives the shell a way to reach the network, and with it `curl` and
        /// `wget`.
        ///
        /// The function is called with a request object and must return a
        /// promise resolving to `{ status, headers, body }` or
        /// `{ error }`. Everything about which hosts are reachable is the
        /// caller's to decide: this asks, it does not route.
        #[wasm_bindgen(js_name = setFetch)]
        pub fn set_fetch(&mut self, fetch: Option<js_sys::Function>) {
            self.sh.borrow_mut().net.enabled = fetch.is_some();
            *self.fetch.borrow_mut() = fetch;
        }

        /// Execution that can wait on the host.
        ///
        /// The interpreter is synchronous and nothing here may block an
        /// isolate, so a run that needs a response it does not have unwinds,
        /// and is restarted once the host has fetched it. See `crate::net`
        /// for why that is the shape, and what it costs.
        #[wasm_bindgen(js_name = execAsync)]
        pub async fn exec_async(&self, script: String) -> Result<ExecOutput, JsError> {
            // Bounded: a script whose next request depends on the last one
            // makes progress each time, but a bug that asked forever would
            // otherwise never return.
            const MAX_REQUESTS: usize = 64;

            self.sh.borrow_mut().net.responses.clear();
            for _ in 0..=MAX_REQUESTS {
                let (result, pending) = {
                    let mut sh = self.sh.borrow_mut();
                    sh.net.rewind();
                    let checkpoint = sh.checkpoint();
                    let result = sh.exec(&script);
                    let pending = sh.net.pending.take();
                    // Roll back only when restarting: a completed run keeps
                    // everything it did.
                    if pending.is_some() {
                        sh.rewind(checkpoint);
                    }
                    (result, pending)
                };

                let Some(request) = pending else {
                    return Ok(ExecOutput {
                        stdout: result.stdout,
                        stderr: result.stderr,
                        exit_code: result.exit_code,
                    });
                };

                let response = self.fetch_one(request).await;
                self.sh.borrow_mut().net.fulfil(response);
            }

            Err(JsError::new("curl: too many requests in one command"))
        }
    }

    impl Bash {
        async fn fetch_one(&self, request: NetRequest) -> NetResponse {
            let failed = |message: String| NetResponse {
                status: 0,
                headers: vec![],
                body: String::new(),
                error: Some(message),
            };

            let fetch = match self.fetch.borrow().clone() {
                Some(f) => f,
                None => return failed("no network in this sandbox".into()),
            };

            let payload = js_sys::Object::new();
            let set = |key: &str, value: JsValue| {
                let _ = js_sys::Reflect::set(&payload, &JsValue::from_str(key), &value);
            };
            set("url", JsValue::from_str(&request.url));
            set("method", JsValue::from_str(&request.method));
            let headers = js_sys::Object::new();
            for (k, v) in &request.headers {
                let _ = js_sys::Reflect::set(&headers, &JsValue::from_str(k), &JsValue::from_str(v));
            }
            set("headers", headers.into());
            match &request.body {
                Some(b) => set("body", JsValue::from_str(b)),
                None => set("body", JsValue::NULL),
            }

            let promise = match fetch.call1(&JsValue::NULL, &payload) {
                Ok(value) => value,
                Err(e) => return failed(describe(&e)),
            };
            let resolved = match wasm_bindgen_futures::JsFuture::from(
                js_sys::Promise::resolve(&promise),
            )
            .await
            {
                Ok(value) => value,
                Err(e) => return failed(describe(&e)),
            };

            let get = |key: &str| js_sys::Reflect::get(&resolved, &JsValue::from_str(key)).ok();
            if let Some(error) = get("error").filter(|v| !v.is_undefined() && !v.is_null()) {
                return failed(error.as_string().unwrap_or_else(|| "request failed".into()));
            }
            let status = get("status").and_then(|v| v.as_f64()).unwrap_or(0.0) as u16;
            let body = get("body").and_then(|v| v.as_string()).unwrap_or_default();
            let mut headers = vec![];
            if let Some(object) = get("headers").filter(|v| v.is_object()) {
                if let Ok(entries) = js_sys::Object::entries(&object.into()).dyn_into::<js_sys::Array>() {
                    for entry in entries.iter() {
                        if let Ok(pair) = entry.dyn_into::<js_sys::Array>() {
                            let k = pair.get(0).as_string().unwrap_or_default();
                            let v = pair.get(1).as_string().unwrap_or_default();
                            if !k.is_empty() { headers.push((k, v)); }
                        }
                    }
                }
            }
            NetResponse { status, headers, body, error: None }
        }
    }

    fn describe(value: &JsValue) -> String {
        value
            .as_string()
            .or_else(|| js_sys::Reflect::get(value, &JsValue::from_str("message")).ok()?.as_string())
            .unwrap_or_else(|| "request failed".into())
    }

    #[wasm_bindgen]
    impl Bash {

        #[wasm_bindgen(js_name = writeFile)]
        pub fn write_file(&mut self, path: &str, content: &str) -> Result<(), JsError> {
            let mut sh = self.sh.borrow_mut();
            let p = crate::fs::normalize(&sh.cwd, path);
            let parent = crate::fs::parent(&p);
            sh.fs.mkdir(&parent, true).map_err(|e| JsError::new(&e))?;
            sh.fs.write(&p, content.as_bytes(), false).map_err(|e| JsError::new(&e))
        }

        #[wasm_bindgen(js_name = readFile)]
        pub fn read_file(&self, path: &str) -> Option<String> {
            let sh = self.sh.borrow();
            let p = crate::fs::normalize(&sh.cwd, path);
            sh.fs.read(&p).ok().map(|d| String::from_utf8_lossy(d).into_owned())
        }

        /// The byte-exact pair of `writeFile`/`readFile`.
        ///
        /// The string versions lose anything that is not valid UTF-8, which
        /// is every gzip stream and every tarball. A caller moving files in
        /// and out of the sandbox has to use these or a `.tar.gz` written
        /// inside will not survive the trip.
        #[wasm_bindgen(js_name = writeFileBytes)]
        pub fn write_file_bytes(&mut self, path: &str, content: &[u8]) -> Result<(), JsError> {
            let mut sh = self.sh.borrow_mut();
            let p = crate::fs::normalize(&sh.cwd, path);
            let parent = crate::fs::parent(&p);
            sh.fs.mkdir(&parent, true).map_err(|e| JsError::new(&e))?;
            sh.fs.write(&p, content, false).map_err(|e| JsError::new(&e))
        }

        #[wasm_bindgen(js_name = readFileBytes)]
        pub fn read_file_bytes(&self, path: &str) -> Option<Vec<u8>> {
            let sh = self.sh.borrow();
            let p = crate::fs::normalize(&sh.cwd, path);
            sh.fs.read(&p).ok().map(|d| d.to_vec())
        }

        pub fn cwd(&self) -> String {
            self.sh.borrow().cwd.clone()
        }

        /// Names of all built-in commands.
        pub fn commands() -> Vec<String> {
            crate::commands::names().into_iter().map(String::from).collect()
        }
    }
}
