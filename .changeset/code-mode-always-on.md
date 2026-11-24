---
"@cloudfarm/computer": minor
---

Code mode can no longer be turned off. `codeEngine: null` now resolves the
default engine, exactly as leaving the field unset does.

Chaining several actions in one pass is the reason the tool surface stays at
five whatever is installed, so a Computer without code mode is a different,
worse product rather than a configuration of this one. A shell stays genuinely
optional — `provider: null` still means no shell.

The `code` tool also no longer waits for an app to be installed. It was gated
on the action registry being non-empty, which withheld it from a bare
Computer — exactly when `run("fs.read")` and `run("bash")` in one pass are
most useful.

One platform caveat, unchanged: on Workers the default cannot resolve itself,
because the wasm must be a static import that only your bundler can emit. Pass
`quickjsForWorkers(wasmModule)` there, or code mode is unavailable whatever
this option says.
