import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/testing.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2023",
  // Re-exported, not inlined: a consumer who also imports `@cloudfarm/computer`
  // directly must get the same module instance, or `setTestDefaults` and the
  // registry would be duplicated in one process.
  external: ["@cloudfarm/computer", "@cloudfarm/rbash-sandbox", "@cloudfarm/qjs-engine", "zod"],
});
