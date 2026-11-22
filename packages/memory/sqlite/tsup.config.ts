import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "node22",
  platform: "node",
  // tsup strips the `node:` prefix by default, which turns `node:sqlite` into
  // a bare `sqlite` that resolves to nothing — and only at runtime, long after
  // the build and the typecheck have both passed.
  removeNodeProtocol: false,
  external: ["@cloudfarm/core", "zod"],
});
