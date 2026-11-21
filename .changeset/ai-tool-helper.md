---
"@cloudfarm/ai": patch
---

Build tools with the AI SDK's own `tool()` helper rather than assembling the
object by hand, alongside the existing `jsonSchema()` wrapping. The adapter now
uses the SDK's types and transformations throughout, so its output is whatever
the installed SDK says a tool is.
