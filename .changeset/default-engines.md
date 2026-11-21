---
"@cloudfarm/core": minor
---

`provider` and `codeEngine` now default to `@cloudfarm/bash` and
`@cloudfarm/quickjs` when those packages are installed, so `new Computer()`
with no options has a shell and code mode. Both remain optional; pass your own
to swap, or `null` to turn either off. They are resolved at runtime rather than
imported, because both packages depend on core — on Workers, configure
`quickjsForWorkers(wasmModule)` explicitly.
