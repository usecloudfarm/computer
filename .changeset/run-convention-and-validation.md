---
"@cloudfarm/core": minor
"@cloudfarm/quickjs": minor
---

Code mode now uses one calling convention, `run(ref, input)`, matching the `run`
tool — so a snippet worked out in code mode replays as a single tool call, and
there is one shape to learn rather than two. The generated types are emitted as
overloads of `run` keyed by ref.

Source is also validated before it executes: unknown refs (with a "did you
mean"), `await`, `import`/`require`/`fetch`, and syntax errors come back as
diagnostics with line numbers, having run nothing. Previously a typo on the
third line would land the first two calls as real side effects before failing.
