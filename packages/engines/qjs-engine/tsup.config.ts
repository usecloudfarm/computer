import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/engine.ts", "src/node.ts", "src/workers.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2023",
  external: [
    "@cloudfarm/computer",
    "quickjs-emscripten-core",
    "@jitl/quickjs-wasmfile-release-asyncify",
    "zod",
  ],
});
