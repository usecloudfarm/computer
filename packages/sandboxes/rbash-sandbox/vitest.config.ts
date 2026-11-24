import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../../vitest.config.js";

/**
 * The Node suite. `*.workers.test.ts` is left out because it needs a D1
 * binding, which only exists under workerd — `pnpm test:workers` runs those.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({ test: { exclude: ["**/node_modules/**", "**/*.workers.test.ts"] } }),
);
