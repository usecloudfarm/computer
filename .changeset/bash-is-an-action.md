---
"@cloudfarm/core": minor
---

The computer's own capabilities are now actions, not special cases. `bash`,
`code`, `fs.*` and `apps.list` are indexed for `search`, listed by `list_apps`
under a `computer` app, and run with `run` — the same path as
`slack.sendMessage`.

`run` means "run something in this computer", and the shell is part of the
computer. So the dedicated `bash` tool is gone: 6 tools become 5.

This closes a real hole rather than only tidying. `search("run a shell
command")` previously returned **nothing** — built-ins were reachable by ref
but invisible to the discovery path the whole design leans on, so the only way
to learn `bash` existed was to already know. It now returns `bash`, with its
signature and a runnable example.

A built-in whose optional package is absent is filtered out of search and the
app list, so a model is never pointed at a ref that cannot work. `run`'s
description names the common built-in refs, so reaching the shell still costs
one call and no search.
