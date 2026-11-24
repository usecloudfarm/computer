# rust-bash

A sandboxed bash interpreter with an in-memory filesystem, written in Rust and compiled to WebAssembly, for AI agents.

```js
const { Bash } = require("./pkg/rust_bash.js");
const b = new Bash();
b.writeFile("data.json", '[{"n":1},{"n":5}]');
const { stdout, stderr, exitCode } = b.exec("jq '[.[].n] | add' data.json");
```

- `./build.sh` builds `pkg/` (Node) and `pkg-web/` (browser, Workers).
- `python3 tests/compat.py` diffs 102 scripts against GNU bash (needs `cargo build --release`).
- `node bench/wasm-compat.mjs`, `node bench/limits.mjs`, `cd bench && npm i && node bench.mjs` (vs just-bash).
- `cd worker && npm i && npx wrangler dev` runs it as a Cloudflare Worker.
- `cargo build --no-default-features` drops jq (about half the binary).
