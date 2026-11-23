---
"@cloudfarm/e2b-sandbox": patch
---

E2B runs on Cloudflare Workers. The original plan listed this as a risk — the
SDK is Node-shaped, requiring `node:crypto`, `node:fs`, `node:os`,
`node:path`, `node:stream` and `node:url` at the top level — and
`nodejs_compat` satisfies all of them.

Pinned by a workerd-pool test that loads the SDK and the provider, plus a
live one, skipped without `E2B_API_KEY`, that boots a microVM and runs a
command from inside workerd.
