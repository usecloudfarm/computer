---
"@cloudfarm/computer": minor
---

The `run`, `code` and `fs` tool descriptions are built from what a computer
actually has rather than fixed in a constant.

`run` names only the built-ins that are available — no `'bash'` when no
sandbox is configured. It quotes
the sandbox provider's own description too, so a model is told up front that
the default shell cannot run npm, node or python instead of discovering it by
failing. `fs` carries the storage provider's description, so "lost when the
process ends" is visible before anything is written.

The ref list comes from the registry's availability-filtered built-ins — the
same source `search` and `list_apps` use — so a description cannot name a ref
that dispatch would reject.
