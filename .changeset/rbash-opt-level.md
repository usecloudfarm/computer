---
"@cloudfarm/rbash": patch
"@cloudfarm/rbash-sandbox": patch
---

Compile the wasm for speed, not size.

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
