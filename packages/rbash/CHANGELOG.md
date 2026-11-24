# @cloudfarm/rbash

## 0.1.0

### Minor Changes

- c6ad0e0: Split the bash interpreter out as `@cloudfarm/rbash`.

  The wasm shell never knew anything about a Computer — its whole surface is
  `exec`, `execAsync`, `setFetch`, the file pairs and `cwd` — so it is now its
  own package and usable on its own, the way `just-bash` is. A sandboxed bash
  with an in-memory filesystem, no container, no subprocess, no host disk.

  `@cloudfarm/rbash-sandbox` becomes the adapter: it depends on the interpreter
  and adds the workspace mapping, the `ExecResult` envelope and `curl` routed
  through the host's allowlisted fetch. Nothing changes for a Computer, which
  still finds the provider by what is installed.

  The wasm asset moves with the interpreter, so a Workers bundle imports
  `@cloudfarm/rbash/wasm` rather than `@cloudfarm/rbash-sandbox/wasm`.
