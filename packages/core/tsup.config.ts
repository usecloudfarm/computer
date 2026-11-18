import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  // Keep workspace deps external so consumers resolve the published package.
  external: ["@unsandbox/utils"],
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
});
