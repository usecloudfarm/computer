---
"@cloudfarm/core": patch
---

Fix the generated `.d.ts` declaring refs that do not exist.

`renderDeclarations` rebuilt each ref as `appId + "." + action.name`. That is
correct for an app — `slack.sendMessage` — and wrong for every built-in, whose
app is `computer` while its ref is `bash`, `fs.read` or `memory.remember`. The
types handed to a model declared `computer.bash` and `computer.remember`,
which `run` rejects.

`DeclarationEntry` now carries the real ref. The bug arrived with built-ins
becoming searchable and was invisible because the `@example` line beside each
declaration was right, so a model following the example still worked.
