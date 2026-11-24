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
    // 15s, not vitest's 5s. Every file gets its own workerd isolate, and the
    // release job runs this suite beside every other package's on a shared
    // two-core runner — where four of these timed out at exactly 5000ms while
    // the CI workflow passed the same commit. The tests are not slow; the
    // machine is busy, and a timeout that trips on contention tests nothing.
    testTimeout: 15_000,
  },
});
