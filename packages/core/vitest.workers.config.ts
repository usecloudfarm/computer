import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

/**
 * The isomorphism guarantee: core's entire suite runs inside workerd, not just
 * in Node. If anything here reaches for a Node built-in, this fails — which is
 * why `pnpm test:workers` is a separate CI step rather than an optional extra.
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
