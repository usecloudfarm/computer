---
"@cloudfarm/computer": major
"@cloudfarm/bash-sandbox": major
"@cloudfarm/qjs-engine": major
"@cloudfarm/s3-storage": major
---

One shell, one engine, neither configurable.

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
