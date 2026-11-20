---
"@unsandbox/sandbox-core": minor
"@unsandbox/runtimes": minor
---

Add the pluggable sandbox layer: a `SandboxRuntime` contract with streamed run
events, an in-memory workspace shared across engines, and five runtimes
(QuickJS, V8 isolate, CPython via Pyodide, bash via just-bash, host dash).
Blocking engines run in warm, killable worker threads so a runaway guest cannot
wedge the host.
