import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

/**
 * The D1 half of the suite, against a real binding.
 *
 * `node:sqlite` cannot stand in for D1 in the way that matters: D1 is
 * asynchronous, has no `BEGIN`, and has its own opinion about what counts as a
 * blob parameter. Only the real client settles that, so it runs here.
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["src/**/*.workers.test.ts"],
  },
});
