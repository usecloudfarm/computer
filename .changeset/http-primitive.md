---
"@cloudfarm/core": minor
"@cloudfarm/slack": minor
---

Add `context.http`, a JSON client over the app's authorized fetch, configured
per app with `createApp({ http: { baseUrl, headers, validate } })`.

This fixes a behavioural bug, not just boilerplate. Apps were throwing bare
`Error`s for transport failures, and `classifyError` can only report an
anonymous Error as `internal` with `retryable: false` — so an upstream 429
reached the model as a permanent internal fault. `HttpError` carries the
status: 429 is now `rate_limited` and retryable, 401/403 `not_authenticated`,
5xx/408 a retryable `upstream_error`, and other 4xx non-retryable. An app can
flag an application-level rejection as retryable with `UpstreamRejectedError`.

`baseUrl`'s host is added to `allowedHosts` automatically. `context.fetch`
is unchanged and remains the escape hatch.
