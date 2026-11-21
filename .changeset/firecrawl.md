---
"@cloudfarm/firecrawl": minor
---

Add `@cloudfarm/firecrawl`: `firecrawl.search` (web search, optionally with
each result's page content), `firecrawl.scrape` (a page as markdown), and
`firecrawl.map` (every URL on a site).

Search is the one that changes what an agent can do. Without it, an agent can
only fetch URLs the task already named; with it, it can find the page it
needs. `scrape` overlaps with `web.read` from `@cloudfarm/cloudflare-browser`
on purpose — different vendors, and a workspace can install either, both, or
neither.

Page content is capped per result rather than per response, because ten
results with content is ten pages arriving at once, and a long scrape is
written to the workspace and reported by reference.
