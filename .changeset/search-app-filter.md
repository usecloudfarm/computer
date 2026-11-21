---
"@cloudfarm/core": minor
---

`search` takes an optional `app`, scoping results to one app's actions —
`{ useCase: "read the comments", app: "hackernews" }`, or `app: "computer"`
for the shell and filesystem.

The registry over-fetches when scoped, because filtering happens after
ranking: without it, a query another app wins could return the top `limit`
hits, drop them all, and answer nothing.

An `app` that is not installed is an `invalid_args` error listing the ids that
are, rather than an empty result — zero hits reads as "this computer cannot do
that" when the truth is "no such app".
