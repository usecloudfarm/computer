---
"@cloudfarm/computer": minor
---

`code` is a tool, and no longer also a ref.

It was both, which made it the last name on the surface that could be reached
two ways — the same asymmetry that taught models to call `bash` as a tool of
its own. And the two ways did not answer alike: the tool returns the
`CodeResult`, while `run("code", { source })` wrapped it, handing back
`{ status: "ok", value: { outcome, value, … } }` — two nested result shapes
with the real value at `value.value`, and a failed script reporting
`status: "ok"` because the dispatch succeeded. That is the confusion
`CodeResult`'s own schema comment exists to avoid.

Indexing it bought nothing either. A tool is in context on every request, so
it never needed `search` to be found; being in the registry only meant it
competed in search results and appeared in `apps.list` and the generated
`.d.ts` as an action.

So `code` is gone from `builtinActions`, from `run`'s description, and from
the dead `case "code"` in dispatch that the `run()` guard had been shadowing.
The tool is unchanged. One thing falls out for free: a script calling
`run("code", …)` is now refused by validation, before anything executes,
rather than recursing into a nested run.
