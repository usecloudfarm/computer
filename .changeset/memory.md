---
"@cloudfarm/sqlite-memory": minor
"@cloudfarm/core": minor
---

Add `@cloudfarm/sqlite-memory`: a `MemoryStore` over `node:sqlite` with FTS5 —
the first implementation of an interface that had been contract-only.

Core indexes `memory.remember`, `memory.search` and `memory.forget` in
`builtins.ts`, so they are findable with `search` instead of needing to be
known in advance. They appear only when a store is configured.

Two things the FTS5 defaults get wrong for recall, fixed in the schema rather
than worked around: without the `porter` tokenizer "summary" never matches
"summaries", and without a noise list every record sharing the word "the"
competes with the one that matters. Terms are quoted and joined with OR,
because a natural question is a syntax error to FTS5 and recall should widen
rather than narrow.

`MemoryStore` has no scope argument, so one store serves one namespace. A
multi-tenant deployment needs one store per user; sharing one would surface
one user's notes in another's workspace.
