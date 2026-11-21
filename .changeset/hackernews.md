---
"@cloudfarm/hackernews": minor
---

Add `@cloudfarm/hackernews`: the front page, a story's comments, archive
search, and user lookup.

It needs no credentials, so it is the first app that works the moment it is
installed — and a worked example of `noAuth()`, where "no credentials" is a
declared decision rather than a missing field.

Two APIs behind one app, because neither does the other's job: the official
Firebase API is authoritative but has no search, while Algolia indexes the
archive but lags. Reading goes to Firebase, searching to Algolia, and both
hosts are declared since Algolia is reached by absolute URL.

Comment bodies arrive as HTML and are converted to plain text before a model
ever sees them.
