import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/node.ts", "src/workers.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2023",
  platform: "node",
  // The wasm and its wasm-bindgen glue ship as-is under `vendor/`, so the
  // build must not try to bundle or rewrite either.
  removeNodeProtocol: false,
  external: ["node:fs", "node:url", "../vendor/rust_bash.js"],
});
