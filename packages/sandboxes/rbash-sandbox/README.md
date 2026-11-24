# `@cloudfarm/rbash-sandbox`

`rust-bash` as a `SandboxProvider`: a bash interpreter written in Rust and
compiled to WebAssembly, running in this process over the workspace
filesystem.

Same shape as `@cloudfarm/bash-sandbox`, same place in the system, different
interpreter underneath. **Not wired up as the default** — see the trade below.

```ts
import { rbash } from "@cloudfarm/rbash-sandbox";
setTestDefaults({ provider: rbash() }); // see "How it would be adopted"
```

On Workers the wasm has to be handed in, because Workers refuses
`WebAssembly.compile` on bytes and only your bundler can emit a static import:

```ts
import wasmModule from "@cloudfarm/rbash-sandbox/wasm";
import { rbashForWorkers } from "@cloudfarm/rbash-sandbox/workers";

const provider = rbashForWorkers(wasmModule);
```

## What is measured

The `@cloudfarm/bash-sandbox` suite runs against this shell unchanged, in
`parity.test.ts`: 11/11, including the runaway-loop bound, pipelines,
heredocs, write-back and `cwd`. It runs on workerd too, which is the claim it
had to earn — `bash-sandbox` is pure TypeScript and runs there by
construction, where 3.1 MB of wasm is a question only the platform can answer.

Speed is measured by `tools/shell-bench`, 48 cases against `just-bash` on the
same scripts over the same bytes, each checked against an answer computed in
JavaScript before it is timed. `pnpm bench` regenerates
`tools/shell-bench/RESULTS.md`; these rows are its provider layer, which
includes the push/pull both shells pay.

| case                          | just-bash | rbash   | rbash is     |
| ----------------------------- | --------- | ------- | ------------ |
| `echo` (round trip)           | 0.689ms   | 0.037ms | 18.8x faster |
| `sed s///` over 782 KB        | 209ms     | 17.0ms  | 12.3x faster |
| 100 file writes               | 11.5ms    | 0.713ms | 16.1x faster |
| 1000-iteration loop           | 9.59ms    | 0.951ms | 10.1x faster |
| `grep -c` over 78 KB          | 1.73ms    | 0.844ms | 2.0x faster  |
| `jq` group + count over 5k    | 14.2ms    | 10.8ms  | 1.3x faster  |
| `sort \| uniq -c \| sort -rn` | 13.2ms    | 16.9ms  | 1.3x slower  |

Geometric mean across the suite: **4.3x** through `Workspace.exec` and
**6.3x** against the bare interpreters, ahead on 46 of 49 cases. The three it
loses are `sort`-dominated pipelines and `base64`.

Cold start, in a process that has never seen either shell: 8.6ms against
just-bash's 108ms, because loading 3.1 MB of wasm costs less than parsing
517 KB of JavaScript.

Those numbers depend on the build profile. `vendor/Cargo.toml` compiles at
`opt-level = 3`, not `"z"`: at `"z"` the same source ran `jq` 1.8x slower and
glob matching (`${v##*/}`, `case`) 9x slower, losing to the TypeScript shell
on both. `wasm-opt -Oz` in `build.sh` takes the size back afterwards without
giving up the speed.

Upstream also reports 102/102 against GNU bash where just-bash scores 98, and
roughly a sixth of the memory per session. Neither is re-measured here.

## The trade

**For.** Faster on 46 of 49 measured cases, by 4.3x at the geometric mean, and
an order of magnitude on startup. Bounded by default — a runaway loop stops
itself, where `just-bash` needs `executionLimits` set. Ships `jq`. Better bash
coverage upstream. `cwd` survives within a command.

**Against.**

- **3.1 MB of wasm** (1.1 MB gzipped) in the repo and in every bundle.
  Dropping `jq` roughly halves it (`cargo build --no-default-features`).
  0.6 MB of that is the `opt-level = 3` profile, which is what keeps `jq` and
  glob matching ahead of `just-bash` rather than behind it.
- **It is a binary artifact.** The Rust source is vendored beside it under
  `vendor/src/`, but what runs is a `.wasm` no CI step rebuilds.
  `bash-sandbox` is TypeScript you can read in the repo.
- **Binary data does not survive the shell's own stdout.** `printf '\xff'`
  emits `c3 bf`, not `ff`, because the interpreter renders stdout as UTF-8.
  That is upstream and predates this work.

  Files are a different matter and were fixed here: the provider moves bytes
  through `writeFileBytes`/`readFileBytes` rather than the string API, so a
  tarball written in one command is intact in the next. Before that a
  `tar -czf` could not survive its own round trip.

## Commands

`awk` is implemented here, in `vendor/src/awk.rs`: patterns and actions,
`BEGIN`/`END`, fields, `NR`/`NF`/`FS`/`OFS`/`ORS`/`FILENAME`, arrays,
`if`/`while`/`for`/`for-in`, `print`/`printf`, and the string and math
builtins — including POSIX's numeric-string rule, so `$1 < $2` compares
numbers while `"10" < "9"` compares strings. 21/21 against GNU awk. Not there:
user-defined functions, `getline`, and output redirection from inside a rule.

Also added in `vendor/src/coreutils.rs`: `base64`, `md5sum`, `sha256sum`,
`expr`, `diff` (normal and unified, with GNU hunk headers), `comm`, `join`,
`fold`, `expand`, `column`, `strings`, `od`, `split`, `chmod`, `ln`,
`readlink`, `mktemp`, `yes`, `clear`, `true`, `false`, `timeout`, `file`.

In `vendor/src/archive.rs`: `gzip`/`gunzip`/`zcat` (real DEFLATE, via
`miniz_oxide`, with CRC and a gzip header), `tar` (ustar, `-c`/`-x`/`-t`,
`-z`, `-C`), and `rg` — recursive search with ripgrep's grouped output,
smart case and its exit codes.

In `vendor/src/structured.rs`: `yq` (YAML in, the existing `jq` in the
middle, YAML or JSON out), `xan` (`headers`, `count`, `select`, `search`,
`slice`, `sort`, `frequency`, `behead`, `flatten`, over a real CSV reader so
quoted fields survive), and `html-to-markdown`.

In `vendor/src/sql.rs`: `sqlite3`. **It is not SQLite** — the file is JSON
and the real `sqlite3` cannot open it. It is a small SQL engine with the
CLI's shape: CREATE TABLE, INSERT, SELECT (WHERE, GROUP BY, HAVING, ORDER BY,
LIMIT, aggregates, expressions, LIKE, IN, DISTINCT), UPDATE, DELETE, and
`.tables`/`.schema`/`.headers`/`.mode`/`.import`. No joins, subqueries,
indexes or transactions.

`alias`, `unalias` and `history` are interpreter features rather than
commands, in `vendor/src/interp.rs`. `time` exists but `time cmd` is taken by
the parser as a keyword before dispatch, so the command runs untimed — there
is no clock in `wasm32-unknown-unknown` to report, which is also why `date`
is a fixed string.

**Coverage against `just-bash` is 100%** of its 72 commands.

## Network

Off by default. `rbash({ network: true })` gives the shell `curl` and `wget`;
without it they are not "disabled", they do not exist — `command -v curl`
fails and so does calling it. `just-bash` gates its own the same way.

Requests go through `ComputerHost.fetch`, the allowlisted path the rest of the
system uses, so whatever egress policy is in force already applies without
this package knowing about it. A failure is a non-zero exit, not a thrown
error: `curl` should report and continue, not take the script down.

### How it waits, without blocking

The interpreter is synchronous and a host `fetch` is a promise. Nothing in
wasm may block a Cloudflare isolate, so the usual sync-over-async trick —
`Atomics.wait` on a worker thread — is unavailable, and making the whole
interpreter `async` would have meant rewriting some twenty-five mutually
recursive functions.

Instead the run is restartable. When `curl` needs a response it does not
have, it records the request and unwinds through the same path a limit uses.
The caller rolls the filesystem back, awaits the fetch, files the response,
and runs the script again from the top. The replay reaches the same `curl`,
finds the answer waiting, and continues to the next one. `execAsync` drives
that loop; `exec` is still there and still synchronous, with no network on it.

**Each request is issued exactly once.** Replays are served from the record,
so a `curl -X POST` is not repeated — asserted in `network.workers.test.ts`,
against workerd.

What it costs: a script with n requests is executed n+1 times. The replays do
no network and the filesystem is rolled back between them, so only the run
that finishes leaves anything behind. What it requires is that the script be
deterministic up to each request — the same input producing the same sequence
of URLs. That holds here because there is no clock and the random sources are
seeded, but a script that branched on genuine randomness could diverge
between attempts. Capped at 64 requests per command.

## How it would be adopted

Not by passing it in: `ComputerOptions.provider` was removed, so the shell is
whatever `defaultProvider()` finds. Making this the shell means pointing that
at this package.

On Node that is a one-line change, because `rbash()` loads its own wasm from
disk. **On Workers it is not.** The module has to come from the caller's
bundler, so a discovered provider cannot construct itself — the same problem
`ComputerOptions.wasmModule` solves for QuickJS, which would have to cover the
shell too.

## Vendoring

`vendor/` holds the `wasm-bindgen` web build (`rust_bash.js` +
`rust_bash_bg.wasm`), the Rust source it was built from, its `Cargo.toml` and
`build.sh`. The web build is used on both Node and Workers; only how the wasm
is acquired differs. Rebuild with `./build.sh` from a checkout of the crate and
copy `pkg-web/` back over `vendor/`.
