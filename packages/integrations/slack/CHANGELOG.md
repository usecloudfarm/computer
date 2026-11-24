# @cloudfarm/slack

## 0.0.2

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
