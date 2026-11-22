---
"@cloudfarm/core": minor
"@cloudfarm/e2b-sandbox": minor
---

A remote sandbox and the workspace are now one filesystem.

Before this, a Computer with `provider: e2b(…)` had two. `run("bash")` landed
on the microVM's own disk; `workspace.fs` — and so code mode's `fs` — landed
on the storage provider. A file written with `>` was invisible to
`fs.readFileSync` and the reverse, with nothing to say which one you were
looking at. `bash-sandbox` never had the problem because it is a virtual
shell in this process and copies the workspace in and out itself.

`Sandbox` gains an optional `files` API — `read`, `write`, `list`, `entries`,
`remove`. A provider that implements it gets its sandbox kept in step: core
pushes changed files before a command and pulls after, including on failure,
since a command that fails part-way has still written whatever it wrote. A
provider without it behaves exactly as before.

Copying, not mounting. A mount needs an S3-compatible bucket, scoped
credentials and a FUSE client in the image; `Attachment` exists for that and
is better when all three are true. Copying needs none of them, so it works
for every provider and every storage.

`@cloudfarm/e2b-sandbox` implements it over the SDK's filesystem, which
matters: the shell user cannot `mkdir /data`, but an SDK write creates the
directory owned by that user, after which the shell can read and write it.
So workspace paths mirror exactly — `/data/sales.csv` is `/data/sales.csv`
on both sides, with no translation. The provider also makes `/` writable at
connect, so a script can create a top-level directory of its own.
