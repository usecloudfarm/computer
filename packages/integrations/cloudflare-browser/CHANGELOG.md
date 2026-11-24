# @cloudfarm/cloudflare-browser

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
