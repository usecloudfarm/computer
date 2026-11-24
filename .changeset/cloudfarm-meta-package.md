---
"@cloudfarm/computer": minor
"cloudfarm": minor
---

Rename `@cloudfarm/core` to `@cloudfarm/computer`, and add `cloudfarm` — one
install for the Computer, the shell and the engine.

The package holds a Computer, not a core of loose utilities, and the name now
says so. Every import of `@cloudfarm/core` becomes `@cloudfarm/computer`.

Alongside it, `cloudfarm` re-exports that package and depends on
`@cloudfarm/rbash-sandbox` and `@cloudfarm/qjs-engine`. Those two are separate
packages because they implement interfaces defined in the Computer and depend
on it, so it cannot depend on them back — a constraint of the build graph that
a new project should not have to know about. `pnpm add cloudfarm` leaves
nothing to wire up; `@cloudfarm/computer` is still there for anyone choosing a
shell or trimming a Workers bundle.
