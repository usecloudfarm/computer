---
"@cloudfarm/qjs": major
---

Renamed from `@cloudfarm/quickjs` to `@cloudfarm/qjs`.

Nothing else changes: the exports are still `quickjs()` and
`quickjsForWorkers(wasmModule)`, and `defaultCodeEngine` resolves the new
name. Update the dependency and any explicit import.
