---
"@cloudfarm/core": minor
"@cloudfarm/slack": minor
---

Add auth schemes: `createApp({ auth: apiKey() })`, plus `basic()`, `oauth()`,
`noAuth()` and `defineAuth()` for custom ones.

A scheme carries the input schema a developer fills in, the credential schema
that gets stored, the transform between them, and how a request is signed.
Giving `auth` changes what `createApp` returns — an `App` without it, a
`(input) => App` factory with it — so `slack({ apiKey })` is generated from the
scheme rather than hand-written beside it, and the two cannot drift apart.

`options` is a second, non-credential schema (a base URL override, a region)
merged into the same parameter; `http` and `allowedHosts` may be functions of
it. The credential is never placed on `ActionContext`: only the scheme sees it.
`app.auth` publishes the scheme's kind and schemas, never its values.

The deprecated `Slack` class is removed; use `slack({ apiKey })`.

`oauth()` defines the credential shape and signs with the access token; the
flow itself — consent, refresh — is still not implemented.
