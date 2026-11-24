# @cloudfarm/ai-sdk-toolset

## 1.0.0

### Major Changes

- 39c05ae: Renamed so a package name says what it is.

  | was               | is                          |
  | ----------------- | --------------------------- |
  | `@cloudfarm/qjs`  | `@cloudfarm/qjs-engine`     |
  | `@cloudfarm/bash` | `@cloudfarm/bash-sandbox`   |
  | `@cloudfarm/s3`   | `@cloudfarm/s3-storage`     |
  | `@cloudfarm/ai`   | `@cloudfarm/ai-sdk-toolset` |

  The convention: a package is `<what>-<role>`, where the role says what it
  implements — `-sandbox` for the shell, `-engine` for code mode, `-storage` for
  the filesystem, `-toolset` for the tool surface. Apps the
  agent calls keep their bare service name: `@cloudfarm/slack`,
  `@cloudfarm/firecrawl`, `@cloudfarm/hackernews`,
  `@cloudfarm/cloudflare-browser`. The absence of a role is itself the signal.

  `@cloudfarm/computer` is unchanged.

  Only names move. No exports, options or behaviour change.

### Minor Changes

- 8badb16: Stop models calling `bash` as a tool of its own.

  A computer's actions are refs reached through `run`, with one exception that
  is not visible from the outside: `code` and `fs` are tools _as well as_ refs.
  Given those two, "and `bash`" is the reasonable generalisation — and the old
  `run` description invited it, listing `'bash' for the shell ({ cmd })`
  alongside two names that really were tools in the same request. An undeclared
  tool name is rejected before anything executes, so the slip cost a whole turn.

  `run`'s description now shows refs in call position — `{ ref: 'bash', args:
{ cmd } }` — so a ref can never be read as a tool name, and says outright that
  the shell has no tool of its own.

  `@cloudfarm/ai-sdk-toolset` gains `repairToRun()` for the other half, since a description
  cannot make a model infallible:

  ```ts
  streamText({ model, tools: await workspace.tools(), repairToolCall: repairToRun() });
  ```

  It rewrites a call to an undeclared tool into `run` for that ref. Wrong
  guesses are cheap — dispatch answers an unknown ref with an error envelope
  carrying a hint, which the model can act on, where a dead turn gives it
  nothing. It repairs the name only: malformed _arguments_ raise
  `InvalidToolInputError`, which is a real schema mismatch worth surfacing.

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
- Updated dependencies [11b136b]
- Updated dependencies [8badb16]
- Updated dependencies [04e6c75]
- Updated dependencies [2674796]
- Updated dependencies [d422844]
- Updated dependencies [91830ae]
- Updated dependencies [a886176]
- Updated dependencies [8608f55]
  - @cloudfarm/computer@1.0.0

## 0.0.1

### Patch Changes

- First release.

  A Computer gives an agent a workspace: a filesystem, a shell, and actions it
  finds by searching rather than carrying in its context. Five tools whatever is
  installed — `search`, `run`, `code`, `list_apps`, `fs` — so a tenth app costs
  nothing in the system prompt.

  - **`@cloudfarm/computer`** — `Computer` and `Workspace`, the plugin interfaces,
    ref dispatch, BM25 action search, code-mode orchestration with
    validation-before-execution, one result envelope for every call, redaction
    and output clamping. Isomorphic: its whole suite runs under workerd as well
    as Node.
  - **Sandboxes** — `bash` (the zero-infrastructure default), `e2b`, `boat`,
    `agent37`, `vercel-sandbox`.
  - **Engines** — `quickjs`, the default for code mode.
  - **Apps** — `slack`, `hackernews`, `firecrawl`, `cloudflare-browser`.
  - **Toolsets** — `ai`, for the Vercel AI SDK.

- Updated dependencies
  - @cloudfarm/computer@0.0.1
