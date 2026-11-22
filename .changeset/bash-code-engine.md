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

The guest has no Node globals. `js-exec` installs `fs`, `require`, `process`,
`fetch` and `Buffer`; the bootstrap deletes them. `fs` was the one that
mattered: this engine's sandbox is seeded with nothing, so `readFileSync` was
ENOENT for a file the workspace had and `writeFileSync` reported success for a
write the host never saw — silently, and without touching the bridge, so with
no audit trail either. The isolate engine has none of them, so reaching for one
would have forked the dialect.
