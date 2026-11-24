import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/node.ts",
    "src/workers.ts",
    "src/d1.ts",
    "src/d1-http.ts",
    "src/sql.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2023",
  // tsup rewrites `node:sqlite` to `sqlite` unless told not to, and the built
  // `node.js` then imports a package of that name, which does not exist. The
  // tests do not catch it: they resolve `@cloudfarm/source` and run the
  // TypeScript, so `dist` is only ever exercised by a consumer.
  removeNodeProtocol: false,
  external: ["@cloudfarm/computer", "node:sqlite"],
});
