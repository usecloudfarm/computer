---
"@cloudfarm/core": patch
"@cloudfarm/bash": patch
"@cloudfarm/quickjs": patch
"@cloudfarm/ai": patch
"@cloudfarm/slack": patch
---

Lint with oxlint instead of ESLint. Same gates — `node:*` imports and browser
globals stay banned inside `packages/core/src` — on a config that runs in about
a tenth of a second. No source behaviour changes.

Typecheck no longer depends on a prior build. Each package exports a
`@cloudfarm/source` condition pointing at `src`, and `tsc` is pointed at it
through `customConditions`, replacing the composite-project references that
redirected workspace imports to `dist/*.d.ts`. Node and bundlers ignore the
condition and still resolve `import` to `dist`; emitted declarations are
byte-identical.
