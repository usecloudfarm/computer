import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/shell.ts", "src/node.ts", "src/workers.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2023",
  platform: "node",
  external: ["@cloudfarm/computer", "@cloudfarm/rbash"],
});
