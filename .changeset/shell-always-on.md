---
"@cloudfarm/core": minor
---

The shell can no longer be turned off. `provider: null` resolves the default
instead of opting out, exactly as `codeEngine: null` already did.

A shell is part of what makes this a computer rather than a tool router, and
it is what an agent reaches for when no action fits. A Computer without one is
a different, worse product rather than a configuration of this one — and the
inconsistency was its own problem, since `null` meaning "default" in one field
and "off" in the next is the kind of thing nobody reads twice.

`provider` can still come back undefined, but only when `@cloudfarm/bash-sandbox` is
not installed. That is a fact about a deployment rather than a choice about
the product, and the behaviour is unchanged: `bash` stays out of `search`, out
of `run`'s description and out of `apps.list`, and calling it explains how to
install the package.
