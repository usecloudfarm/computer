---
"@cloudfarm/core": minor
---

Bind the workspace's own filesystem, shell and memory into code mode. Generated
code previously reached only app actions, so a script that wanted to read a
file had to bounce back out to the `fs_read` tool — losing the single-turn
advantage code mode exists for. `fs.read/write/list/remove`, `bash({ cmd })` and
`memory.*` are now in scope alongside the apps.
