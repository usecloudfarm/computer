---
"@cloudfarm/core": minor
"@cloudfarm/e2b-sandbox": minor
---

A sandbox that can host code mode now gets it, without being asked.

`SandboxCapability` gains `code`: the sandbox has a JavaScript runtime and a
`files` API to put a script there. A provider declaring it makes
`new Computer({ provider })` resolve `@cloudfarm/node-engine` instead of the
isolate, so a script gets node's real filesystem and real CPU by default.
`@cloudfarm/e2b-sandbox` declares it; `@cloudfarm/bash-sandbox` does not,
because a virtual shell has no `node` and nowhere to put a file.

Core also declares its optional packages as optional peer dependencies. It
discovers `bash-sandbox`, `qjs-engine` and `node-engine` with a runtime
`import`, and under pnpm's isolated layout that import could not see them —
core's own `node_modules` holds only what it declares. It had been working
on leftover symlinks from an earlier install. Declaring them as optional
peers is what makes a package manager link them, so discovery works from a
real install rather than by accident.
