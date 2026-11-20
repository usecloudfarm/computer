import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/testing.ts"],
  // ESM only: every target runtime supports it, and the AI SDK is ESM-only too.
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2023",
  external: ["zod"],
});
