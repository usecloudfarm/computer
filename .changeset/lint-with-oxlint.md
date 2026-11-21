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
