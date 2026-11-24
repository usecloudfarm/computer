# shell-bench

`rbash` against `just-bash`, on the same scripts over the same bytes.

The repository ships two shells and picks one at runtime —
`@cloudfarm/rbash-sandbox` (bash compiled to WebAssembly) when it is
installed, `@cloudfarm/bash-sandbox` (`just-bash`, bash in TypeScript)
otherwise. The README says rbash is "faster on all of them". This is the thing
that checks.

```sh
pnpm bench                                   # build what it needs, then run
pnpm bench --quick                           # 3 iterations, no cold start
pnpm bench --heavy                           # add the 50k–100k-line inputs
pnpm bench --layer=shell --group=search      # one layer, one group
pnpm bench --markdown=tools/shell-bench/RESULTS.md
```

`RESULTS.md` in this directory is a committed snapshot of one run on one
machine. Regenerate it rather than quoting it from memory.

## What it measures

**Two layers**, because the interpreter is only half of what a caller waits
for:

| layer      | what is inside the timed region                                                              |
| ---------- | -------------------------------------------------------------------------------------------- |
| `shell`    | a fresh interpreter, the fixture files handed to it, the script run                          |
| `provider` | the same, through `Computer`: `ws.exec()`, the workspace pushed in, what changed pulled back |

The gap between them is the sync tax both providers pay on every command. On
anything small it is larger than the command.

**Both shells, per case**, grouped by what they stress: startup, filesystem,
search, transform, pipelines, JSON, control flow, and the heavier built-ins
(`gzip`, `tar`, `rg`, `jq`, `yq`, `sqlite3`, `xan`).

**Cold start**, in a child process that has never seen either shell — module
load, wasm instantiation, construction, first command. In-process numbers
cannot see this, and a Worker isolate pays it on the first request.

**Command coverage**, probed rather than declared. Both packages publish a list
of command names, and diffing those lists is wrong in both directions: rbash
does not list its builtins, so `pwd` and `xargs` look missing when they are
there. Every name from both lists is probed with `command -v` inside each
shell.

## What makes the numbers trustworthy

- **Every case carries its expected answer**, computed in JavaScript from the
  same fixture the shell reads. A case that does not produce it is reported as
  a gap instead of timed, because a command that silently does nothing is very
  fast. Several real differences surfaced this way — see `RESULTS.md`.
- **Medians over 10 iterations after 2 warmups**, with the relative standard
  deviation printed next to each one. Treat a gap narrower than the spread as
  noise.
- **A fresh interpreter per iteration**, because that is what both providers do
  per command. A reused instance would benefit from a warm filesystem that
  production never has.
- **Fixtures are generated from a fixed seed**, so another machine compares the
  same bytes without a large directory in the repository.
- **Ratios are averaged geometrically.** An arithmetic mean of speedups says
  10× and 0.1× average to 5×.
- **Output is compared between the two shells** and reported when it differs,
  byte-exactly or at all.

## Layout

```
bench.mjs             CLI, orchestration, the correctness check before each timing
lib/workloads.mjs     the cases: script, fixture, expected answer
lib/fixtures.mjs      seeded generators — logs, CSV, JSON, word lists, file trees
lib/shells.mjs        the four things under test: two shells × two layers
lib/cold-start.mjs    the child-process probes
lib/stats.mjs         timing, quantiles, geometric mean
lib/report.mjs        terminal and markdown rendering
```

## Adding a case

```js
add({
  id: "awk/field-sum-10k",
  group: "transform",
  script: "awk -F, 'NR>1 {s+=$4} END {printf \"%.0f\\n\", s}' sales.csv",
  files: { "sales.csv": csv },
  expect: number(Math.round(total)), // computed from the same fixture, in JS
  heavy: false, // true for inputs only `--heavy` should run
  note: "what this case is for, if it is not obvious",
});
```

Fixture paths are relative. They land under `/data` in the shell and at the
workspace root on the host, so one case definition runs unchanged at both
layers.

## Notes and caveats

- The provider layer needs `dist`. `pnpm bench` builds first; running
  `node tools/shell-bench/bench.mjs` after a `clean` will say so.
- Storage is `MemoryStorage`. A remote bucket would add latency to the provider
  layer that has nothing to do with either shell.
- `just-bash`'s `sqlite3` runs its engine in a worker that does not start under
  a plain `node` process. That is a limitation of this harness as much as of
  the shell, and the case is reported as a gap rather than scored.
- Numbers are machine-specific. The ratios travel better than the milliseconds.
