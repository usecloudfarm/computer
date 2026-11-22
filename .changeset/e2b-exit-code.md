---
"@cloudfarm/e2b-sandbox": patch
---

A non-zero exit is a result again, not a thrown error.

The SDK throws `CommandExitError` when a command exits non-zero, and the
provider let it propagate. The model saw
`{ code: "internal", message: "exit status 1" }` — no stdout, no stderr, no
exit code, nothing to act on — for something as ordinary as `grep` finding
nothing, or an `&&` chain whose last link did.

The error carries the whole result, so the provider now unwraps it into the
`{ status: "failed", exitCode, stdout, stderr }` that `@cloudfarm/bash-sandbox`
has always returned. Errors that are not the command's own — a network
failure, a dead sandbox — still throw, because those are not results.
