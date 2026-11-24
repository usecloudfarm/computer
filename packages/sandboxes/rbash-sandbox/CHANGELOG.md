# @cloudfarm/rbash-sandbox

## 0.1.1

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

- Updated dependencies [d2b68e1]
  - @cloudfarm/rbash@0.1.1

## 0.1.0

### Minor Changes

- fce2c8d: Add `@cloudfarm/rbash-sandbox`: `rust-bash` as a `SandboxProvider` — a bash
  interpreter written in Rust and compiled to WebAssembly, running in this
  process over the workspace filesystem.

  Same shape and same place in the system as `@cloudfarm/bash-sandbox`, with a
  different interpreter underneath. **Not the default**, and not yet adoptable
  on Workers; see the package README.

  The `bash-sandbox` suite runs against it unchanged — 11/11, including the
  runaway-loop bound, pipelines, heredocs, write-back and `cwd` — and a separate
  suite runs it on workerd, which is the claim it had to earn: `bash-sandbox` is
  TypeScript and runs there by construction, where 1.9 MB of wasm is a question
  only the platform can answer.

  Faster on every shape measured through `Workspace.exec`, 1.3x to 5.4x. That is
  lower than the upstream benchmarks report because they time the interpreter
  and this times a whole exec, where copying the workspace in and out dominates
  a small command. It is also bounded by default, where `just-bash` needs
  `executionLimits` set, and it ships `jq`.

  Command coverage went from 57% of `just-bash` to 86% by implementing the gap
  in Rust: `awk` (1,678 lines — patterns, `BEGIN`/`END`, arrays, control flow,
  `printf`, the builtins, and POSIX's numeric-string comparison rule), plus
  `base64`, `md5sum`, `sha256sum`, `expr`, `diff`, `comm`, `join`, `fold`,
  `expand`, `column`, `strings`, `od`, `split`, `chmod`, `ln`, `readlink`,
  `mktemp`, `yes`, `clear`, `true`, `false`, `timeout` and `file`. Checked
  case by case against the GNU tools: 21/21 for awk, and the rest covered by
  tests that run through the wasm.

  Coverage is now **100%** of `just-bash`'s 72 commands. The last ten:
  `gzip`/`gunzip`/`zcat` over real DEFLATE (`miniz_oxide`) with CRC and a gzip
  header; `tar` in ustar format with `-c`/`-x`/`-t`/`-z`/`-C`; `rg` with
  ripgrep's grouped output, smart case and exit codes; `yq`, which parses YAML
  and routes it through the `jq` already linked in; `xan` over a real CSV
  reader; `html-to-markdown`; `sqlite3`; and `alias`/`unalias`/`history` as
  interpreter features.

  `sqlite3` is **not SQLite** — the database is JSON and the real tool cannot
  open it. It is a small SQL engine wearing the CLI's shape, which is what a
  script needs: CREATE TABLE, INSERT, SELECT with WHERE/GROUP BY/HAVING/ORDER
  BY/LIMIT and aggregates, UPDATE, DELETE, and the common dot commands. No
  joins, subqueries, indexes or transactions.

  `time` exists but `time cmd` is taken by the parser as a keyword before
  dispatch, so the command runs untimed. There is no clock in
  `wasm32-unknown-unknown` to report — which is also why `date` is a fixed
  string — and inventing a duration would be worse than reporting none.

  Building this surfaced a real defect: the provider moved files through the
  wasm's string API, so anything not valid UTF-8 was mangled crossing the
  workspace boundary. A `tar -czf` in one command could not be read in the
  next. The wasm now exposes `writeFileBytes`/`readFileBytes` and the provider
  uses them, so archives survive.

  `curl` and `wget` are there too, behind `rbash({ network: true })`. Off by
  default they do not exist at all rather than being disabled, which is how
  `just-bash` gates its own. Requests go through `ComputerHost.fetch`, so the
  egress policy already in force applies unchanged.

  Making that work on Cloudflare Workers is the interesting part. The
  interpreter is synchronous and a host fetch is a promise; an isolate cannot be
  blocked, so `Atomics.wait` on a worker thread is unavailable, and making the
  interpreter `async` would have meant rewriting twenty-five mutually recursive
  functions.

  So the run is restartable instead. `curl` records the request it cannot answer
  and unwinds through the path a limit already uses; the caller rolls the
  filesystem back, awaits the fetch, files the response and runs the script
  again. The replay reaches the same `curl` with the answer in hand. Each
  request is issued exactly once — replays are served from the record, so a
  `curl -X POST` is not repeated, which is asserted against workerd.

  The cost is that a script with n requests runs n+1 times, and that it must be
  deterministic up to each request. That holds here — there is no clock and the
  random sources are seeded — but a script branching on genuine randomness could
  diverge between attempts. Capped at 64 requests per command.

  Costs: 2.2 MB of wasm (0.8 MB gzipped) in every bundle, and what runs is a
  binary no CI step rebuilds.

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

- Updated dependencies [0cb3f0f]
- Updated dependencies [4ddbcb6]
- Updated dependencies [fce2c8d]
- Updated dependencies [f7bc7ed]
- Updated dependencies [31eeac8]
- Updated dependencies [dda004d]
- Updated dependencies [cf82e76]
- Updated dependencies [0a4aa8d]
- Updated dependencies [1590b7e]
- Updated dependencies [c6ad0e0]
- Updated dependencies [11b136b]
- Updated dependencies [8badb16]
- Updated dependencies [04e6c75]
- Updated dependencies [2674796]
- Updated dependencies [d422844]
- Updated dependencies [91830ae]
- Updated dependencies [a886176]
- Updated dependencies [8608f55]
  - @cloudfarm/computer@1.0.0
  - @cloudfarm/rbash@0.1.0
