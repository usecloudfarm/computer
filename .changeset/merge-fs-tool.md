---
"@cloudfarm/core": minor
---

Merge `fs_read`, `fs_write` and `fs_list` into one `fs` tool taking
`{ op, path?, content? }`. The agent's tool count drops from 8 to 6.

The three were one concept with three verbs — same substrate, same envelope,
same availability — so splitting them spent three tool slots on what a single
enum expresses. The schema is flat rather than a union per op, because models
fumble `oneOf` more often than "this field goes with that op".

The refs are unchanged: `run("fs.read", { path })` still works and is still
what code mode writes, since it reads better there than `run("fs", { op })`.
`fs.remove` is still reachable by ref and still absent from the tool's enum,
exactly as before.

One cost worth naming: the merged tool is annotated `write`, the superset of
its ops, so a read through it no longer carries a read-only hint.
