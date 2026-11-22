---
"@cloudfarm/bash-code": minor
"@cloudfarm/core": minor
"@cloudfarm/quickjs": patch
---

Add `@cloudfarm/bash-code`: code mode run inside the bash sandbox, where a
script can `await`.

`just-bash` already ships QuickJS as its `js-exec` command, backed by the
`run` package, which puts the guest in a worker thread and parks it on
`Atomics.wait` while the host does async work. That is how `await` becomes
possible — and why this is Node and Bun only, since a Worker cannot spawn
threads. `@cloudfarm/quickjs` stays the default and the only engine that runs
on workerd; nothing resolves this one automatically.

The dialect does not fork. `job.prelude` is core's, verbatim: both engines
build `run` and `console` on `__host` and `__log`, so a script written for one
runs on the other and `await` is something a script may use rather than must.

The host bridge is `run(ref, args)` and nothing else. just-bash offers host
functions as a `tools.a.b()` proxy; the bootstrap captures it, defines
`__host` over it, then deletes `tools`. The ref travels as an argument rather
than a property path, because a path would require every ref to be a chain of
valid identifiers and the first one that is not would split the dialect from
what `run` accepts.

Core gains `CodeEngineCapabilities.guestAwait`, distinct from `asyncHostCalls`
— the isolate suspends its wasm stack across a host call, so a call returns
rather than resolving, and `await` is a syntax error there. Validation and the
`code` tool's description both read it, so a computer no longer forbids what
its engine would accept. The "everything is SYNCHRONOUS" sentence moves out of
`CodeInput`'s fixed schema text and into the generated description, where it
can tell the truth about the engine in use.

The guest keeps `require` and gets a real filesystem. The engine seeds its
shell from the workspace and writes back after, so `require("fs").readFileSync`
reads the file the workspace has and `writeFileSync` leaves one behind. This is
the reason to run code mode inside the sandbox at all: without it a script
reads a file by writing shell, quoted inside a JS string, inside JSON —
`run("bash", { cmd: "cat " + path })` — to do what one line of JS does.

Core gains `CodeEngineCapabilities.guestModules`, which makes the prelude, the
validator and the `code` tool's description agree about whether `require`
exists; previously each decided alone, so the modules were present and
unusable. `CodeJob` gains an optional `fs`, handed over only to an engine
declaring the capability — an engine without it gets no filesystem rather than
a scratch one that discards writes.
