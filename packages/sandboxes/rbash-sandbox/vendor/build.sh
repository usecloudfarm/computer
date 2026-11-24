#!/usr/bin/env bash
# Build rust-bash to WASM: cargo → wasm-bindgen → wasm-opt.
set -euo pipefail
cargo build --release --target wasm32-unknown-unknown --lib
wasm-bindgen --target nodejs --out-dir pkg target/wasm32-unknown-unknown/release/rust_bash.wasm
wasm-bindgen --target web --out-dir pkg-web target/wasm32-unknown-unknown/release/rust_bash.wasm
for d in pkg pkg-web; do
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
    $d/rust_bash_bg.wasm -o $d/rust_bash_bg.wasm
done
ls -la pkg/rust_bash_bg.wasm
