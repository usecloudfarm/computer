---
"@cloudfarm/core": major
"@cloudfarm/quickjs": minor
---

Every call now answers with one envelope: `{ status: "ok", value }` or
`{ status: "error", error: { code, message, hint?, retryable, details? } }`.
That holds for the `run` tool, the built-in `fs`/`bash`/`memory` refs, app
actions, and `run()` inside code mode — so a model never has to learn
which surfaces throw and which return, and never has to guess whether a bare
value meant success.

`Workspace.run()` no longer throws for expected failures; `CodeResult.status`
is renamed `outcome`, because `status` now belongs to the envelope and two
nested keys of that name meaning different things is exactly the confusion
worth avoiding. Rejected source is reported as a failed call with code
`invalid_code`, carrying its diagnostics in `error.details`.
