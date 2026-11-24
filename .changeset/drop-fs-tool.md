---
"@cloudfarm/computer": minor
---

Drop the `fs` tool. The surface is four tools now: `search`, `code`, `run`,
`list_apps`.

Files are what a shell is for. `cat`, `head`, `grep`, `ls` and a heredoc cover
everything the tool did, and one way to reach the filesystem is one fewer
thing to choose between — the two-ways-to-do-it shape is what taught a model
to call `bash` as a tool of its own in the first place.

`run`'s description now teaches those commands, and how not to drown in them:
`wc -l` before reading something unsized, `grep` instead of reading a file to
search it, `head`/`tail` instead of whole files. Output is clamped either way,
so `cat` on a large file spends context and still arrives incomplete — naming
the cheaper commands is more use to a model than telling it to be careful. The
storage provider's own line about where files live moves here too, since
whether a file survives the turn changes whether writing it was worth doing.

`fs.read` / `fs.write` / `fs.list` are unchanged as refs: they take `{ path }`
and `{ path, content }` as arguments, which beats quoting when the content is
awkward, and code mode has nothing else to call.

Code mode is unaffected — `run('fs.write', { path, content })` works as
before — but its description now says why it points at the fs refs where
`run` points at the shell: inside a script a heredoc ends up quoted in a JS
string inside JSON, three levels deep, while `fs.write` takes the content as
an argument.
