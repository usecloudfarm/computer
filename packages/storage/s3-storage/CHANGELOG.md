# @cloudfarm/s3-storage

## 1.0.0

### Major Changes

- 1590b7e: One shell, one engine, neither configurable.

  `@cloudfarm/e2b-sandbox`, `@cloudfarm/vercel-sandbox`, `@cloudfarm/boat-sandbox`,
  `@cloudfarm/agent37-sandbox` and `@cloudfarm/node-engine` are deleted. The
  shell is `just-bash` and code mode is QuickJS, both found at runtime.
  `ComputerOptions.provider` and `ComputerOptions.codeEngine` are gone, with no
  replacement.

  What the remote sandboxes cost was never the code that talked to them. It was
  everything underneath: two filesystems and a copy sync around every command to
  pretend they were one, a second code-mode engine that ran inside the sandbox,
  bucket credentials handed to a machine running model-written code, and two
  dialects of the same `fs` to keep in step. What they bought was `npm` and
  `python`.

  The numbers that settled it, measured against E2B on 2026-11-23: ~1s to create
  a microVM, ~6s more to mount storage over FUSE, 1.6s median for a warm
  `code()` call and a tail into the tens of seconds when its filesystem RPC
  stalled. The in-process isolate does the same call in 2–5ms over the same
  filesystem the host reads.

  ### Removed
  - `ComputerOptions.provider`, `ComputerOptions.codeEngine`
  - `Attachment`, `StorageProvider.attachment()`, `ComputerHost.attachment`,
    `S3StorageOptions.attachCredentials` — mounting was their only caller
  - `SandboxFiles`, `Sandbox.files`, `Sandbox.mounted`, `SandboxSync` — one
    filesystem needs no reconciling
  - `CodeEngineCapabilities.sandboxed`, `CodeJob.sandbox`, `PreludeOptions`
  - `"mount"` and `"code"` from `SandboxCapability`

  ### Added
  - `ComputerOptions.wasmModule`, for Workers only. Not a choice of engine:
    Workers refuses `WebAssembly.compile` on bytes, so the module has to arrive
    as a static import and only your bundler can emit one.
  - `setTestDefaults()`, the seam `provider` used to be. Tests need to assert
    what reached the shell; that was never a reason to let a consumer swap it.

  `SandboxProvider` and `Sandbox` remain exported, because core and
  `@cloudfarm/bash-sandbox` are separate packages and need a shared type. They
  are not an extension point — nothing accepts one.

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

- 04e6c75: Add `@cloudfarm/s3-storage`: workspace files in any S3-compatible bucket you own —
  AWS, R2, MinIO, B2. Signed with `aws4fetch` (SigV4 over WebCrypto), so it runs
  unchanged on Node and Workers where an AWS SDK would not.

  Each `{ userId, workspaceId }` gets its own key prefix, which is both the
  tenant boundary and the thing a scoped credential should be pinned to.

  Keys are laid out as `<prefix>/<userId>/workspaces/<workspaceId>/`. The user
  owns the root folder, so anything of theirs that outlives a single workspace
  has somewhere to sit beside `workspaces/`.

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
