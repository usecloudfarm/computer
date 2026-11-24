---
"@cloudfarm/computer": major
---

Remove the `list_apps` tool. The surface is three: `search`, `code`, `run`.

`search` finds, `code` chains, `run` does. `list_apps` was `search` with an
empty query and a different result shape, and it was the second place a model
could learn a ref exists without learning how to call it — the same shape that
taught models to call `bash` as a tool of its own.

`apps.list` stays an action, so nothing is unreachable: `search` ranks it
first for "what is installed", "what apps are available" and "what can you
do", and the playground's own Apps panel still calls it through `run`.

That last query exposed a real bug, fixed here: a query made entirely of
stopwords tokenized to nothing and returned no results at all. "what can you
do" is the most natural way to ask what a computer has, and it was answered
with silence — which mattered less when `list_apps` was a tool you could just
call. Stopword removal now never empties a query; if every term is a
stopword, the query falls back to matching on them.
