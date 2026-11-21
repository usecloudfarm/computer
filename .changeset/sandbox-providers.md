---
"@cloudfarm/core": minor
"@cloudfarm/boat": minor
"@cloudfarm/agent37": minor
"@cloudfarm/e2b": minor
"@cloudfarm/vercel-sandbox": minor
---

Add four sandbox providers: `@cloudfarm/boat` and `@cloudfarm/agent37` over
their REST APIs, `@cloudfarm/e2b` and `@cloudfarm/vercel-sandbox` over their
SDKs as optional peers.

Core gains `execHandle()` and `toExecResult()`. Every remote provider has the
same shape underneath — POST a command, wait, map `{ exitCode, stdout,
stderr }` — and four copies of that adapter would be four places for the event
order to drift.

The two REST providers use plain `fetch`, so they run on Workers as well as
Node; their vendors' SDKs are Node-shaped and would have cost that for no
capability we need. Both re-attach from `serialize()` rather than starting a
second machine, because a leaked machine bills until its TTL expires.
