---
"@cloudfarm/core": major
---

Remove the `fs.*` actions. The shell is the filesystem.

`fs.read`, `fs.write`, `fs.list` and `fs.remove` are gone from the computer's
actions, from `run`'s description and from dispatch. What the model has left
is `bash` and `apps.list` — `cat`, `ls`, `grep`, `>` and `rm` do the rest.

They were a second filesystem surface over the same bytes, so every file the
model touched came with a choice that did not matter, and the two-ways-to-do-it
shape is what has caused every confusion on this surface so far. The shell was
already the documented way to reach files; this removes the alternative rather
than describing it again.

Code mode is unaffected in reach and changes in spelling: `run("bash", { cmd })`
is how a script touches files now, and the `code` tool's description says to
build commands with template strings rather than hand-quoting them. A heredoc
interpolated from a template literal works, which is the case the fs refs were
kept for.

`workspace.fs` is untouched. It is the API for the program embedding a
Computer — the playground's own file explorer uses it — and was never part of
what the model sees.

Measured before removing: reading one file through `bash` costs about 3ms
against a 400KB workspace, where `fs.read` was effectively free, because the
default provider snapshots the workspace per command. Real, and far below the
latency of the model deciding to make the call.
