---
"@cloudfarm/computer": minor
---

Remove memory as a concept: the `MemoryStore` port, the `MemoryRecord` schema,
the `memory` option, the three `memory.*` built-ins, and the
`@cloudfarm/sqlite-memory` package.

It was redundant with the workspace. An agent handed a filesystem that
outlives its context already writes notes to it — in the playground it chose
`/memory/user_preferences.md` before memory actions existed — so a second,
narrower store bought nothing a `fs.write` did not, while costing a port, a
package, three indexed actions competing with `fs.*` in search, and a
scope-less interface that would have surfaced one user's notes in another's
workspace if a deployment shared it.

The convention replaces the capability: keep what you learn in `/memory/*.md`.
Markdown is editable, diffable and greppable with `bash`, and it needs no
second backend to persist.
