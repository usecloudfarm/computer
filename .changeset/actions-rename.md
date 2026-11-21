---
"@cloudfarm/core": minor
"@cloudfarm/slack": minor
"@cloudfarm/quickjs": minor
"@cloudfarm/bash": minor
"@cloudfarm/ai": minor
---

Rename the agent-facing unit of work from "capability" to "action", and expose
the authoring helper as `createAction`.

`createApp({ actions: { … } })`, `App.actions()`, `ActionDefinition`,
`ActionContext`, `ActionRegistry`, `ActionIndex`, `SearchResult.actions`. Model
-facing text follows: `No action named "…"`, and the `search`/`code` tool
descriptions.

A sandbox's or engine's `capabilities` keep that name. They are feature flags —
"does this provider support bash?" — never exposed to a model, and conflating
them with the units an agent calls would make both harder to read.
