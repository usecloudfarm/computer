import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  external: ["@unsandbox/sandbox-core", "pyodide", "quickjs-emscripten", "just-bash"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  // The worker entry ships as-is: `new Worker()` needs a real file on disk.
  onSuccess: "cp src/engine-worker.js dist/engine-worker.js",
});
