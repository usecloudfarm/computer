---
"@cloudfarm/qjs-engine": minor
"@cloudfarm/core": patch
---

`await` works in code mode.

The engine already ran on the asyncify variant with `evalCodeAsync` and an
asyncified host function — the only thing stopping `await` was that the guest
was wrapped in a non-async arrow, so it failed to compile. Wrapping it in an
async one and resolving the returned promise is the whole change.

Worth doing because models write `await` by habit, and a hard rejection cost
a whole turn to learn a rule that bought nothing.

It buys correctness, not speed, and the description says so. Asyncify unwinds
the entire wasm stack for each host call and cannot be re-entered while
unwound, so calls are serialised however a script is written. Measured:
`Promise.all` of four 200ms actions takes 808ms — the same as awaiting them
one at a time. A model reaching for `Promise.all` expects the opposite, so
the `code` tool now states it.
