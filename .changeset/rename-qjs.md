---
"@cloudfarm/qjs-engine": major
---

Renamed from `@cloudfarm/quickjs` to `@cloudfarm/qjs-engine`.

Nothing else changes: the exports are still `quickjs()` and
`quickjsForWorkers(wasmModule)`, and `defaultCodeEngine` resolves the new
name. Update the dependency and any explicit import.
