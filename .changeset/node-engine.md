---
"@cloudfarm/node-engine": minor
"@cloudfarm/core": minor
---

Add `@cloudfarm/node-engine`: code mode run with `node` inside the sandbox.

The isolate is 64 MiB with no real filesystem, and its `fs` is a shim that
turns every read into a host call. This engine writes the script into the
sandbox and runs it on the runtime already there, so the script gets node's
own `fs` — binary-safe, no size limit, no host call per read — real CPU, and
whatever the image has installed. Measured against a live E2B microVM: a
50 MB file written locally in 2.2s, a Buffer surviving a round trip intact,
and `python3` spawned from JavaScript.

It is not Node-only. The work happens in the sandbox, so the engine is an
HTTP client and runs wherever the provider does, Workers included. What it
cannot do is run without a sandbox, so `@cloudfarm/qjs-engine` stays the
fallback and the zero-config default.

Core gains `CodeEngineCapabilities.sandboxed` and `CodeJob.sandbox`, handed
over only to an engine that declares it. `buildPrelude` gains
`nativeModules`, which omits the `require`/`fs`/`path` shims for such an
engine — without it they shadow node's real modules, which is the whole
benefit undone.

Host calls cross two files and a poll interval, around 3.2s each, because
`exec` is one-way today. A script that mostly works on files pays it once or
not at all; one making many `run()` calls is better off on the isolate.
