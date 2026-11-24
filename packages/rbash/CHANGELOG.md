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

### Patch Changes

- d2b68e1: Compile the wasm for speed, not size.

  `packages/rbash/vendor/Cargo.toml` built at `opt-level = "z"`, which compiled the interpreter
  loop for size and cost more than it saved. The same source at `opt-level = 3`
  runs `jq` 1.8x faster, glob matching — `${v##*/}` and `case` — 9x faster, `sed`
  2.3x, `base64` 2.9x, `awk` 2.1x. The two glob paths were the only places this
  shell lost badly to the TypeScript one; both are now ahead of it, as is `jq`.

  Across `tools/shell-bench`, the geometric mean against `just-bash` moves from
  2.4x to 4.3x through `Workspace.exec`, and from 2.8x to 6.3x against the bare
  interpreters, ahead on 46 of 49 cases rather than 38.

  The wasm grows from 2.56 MB to 3.12 MB — `wasm-opt -Oz` in `build.sh` takes
  most of the increase back. Cold start is unchanged at ~8ms, because V8
  compiles wasm lazily: the module is bigger, and nothing waits for it.

  No API change, and no behaviour change: the package's own suite and its
  workerd suite pass unmodified, and every benchmark case produced byte-identical
  output before and after.
