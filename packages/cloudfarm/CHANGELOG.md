# cloudfarm

## 0.1.0

### Minor Changes

- fce2c8d: Rename `@cloudfarm/core` to `@cloudfarm/computer`, and add `cloudfarm` — one
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

### Patch Changes

- Updated dependencies [0cb3f0f]
- Updated dependencies [4ddbcb6]
- Updated dependencies [fce2c8d]
- Updated dependencies [f7bc7ed]
- Updated dependencies [31eeac8]
- Updated dependencies [dda004d]
- Updated dependencies [cf82e76]
- Updated dependencies [0a4aa8d]
- Updated dependencies [1590b7e]
- Updated dependencies [39c05ae]
- Updated dependencies [fce2c8d]
- Updated dependencies [c6ad0e0]
- Updated dependencies [274f11e]
- Updated dependencies [11b136b]
- Updated dependencies [8badb16]
- Updated dependencies [04e6c75]
- Updated dependencies [2674796]
- Updated dependencies [d422844]
- Updated dependencies [91830ae]
- Updated dependencies [a886176]
- Updated dependencies [8608f55]
  - @cloudfarm/computer@1.0.0
  - @cloudfarm/qjs-engine@1.0.0
  - @cloudfarm/rbash-sandbox@0.1.0
