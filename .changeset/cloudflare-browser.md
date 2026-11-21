---
"@cloudfarm/cloudflare-browser": minor
"@cloudfarm/core": minor
---

Add `@cloudfarm/cloudflare-browser`: the open web as an app, via Cloudflare
Browser Run's REST API. Four actions — `web.read` (page as markdown, with
JavaScript rendered), `web.scrape` (elements by CSS selector), `web.links`,
and `web.screenshot`.

A real browser renders the page, but there is no session to hold open: every
action is one HTTPS request. It runs unchanged on Node and Workers, nothing
bills while idle, and it covers what agents hit most — _read this page_. It
does not click, type or carry state; that is a stateful browser session, and
the `browser` namespace stays reserved for it.

Core gains `context.http.raw()`, returning the untouched `Response` for bodies
that are not JSON. A screenshot is PNG bytes, and there was previously no way
for a handler to reach its own app's base URL and credential without one.

Both large outputs are kept out of the context window: a page over `maxChars`
is written to the workspace and reported by reference, and a screenshot is
never inlined at all.
