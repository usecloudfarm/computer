---
"@cloudfarm/ai": patch
---

Wrap tool input schemas with the AI SDK's `jsonSchema()` helper. The adapter
previously emitted a bare `{ jsonSchema }` object, which the SDK rejects —
it brands schemas with a symbol before it will validate against them. `ai` is
now a peer dependency so the toolset types as a real `ToolSet`.
