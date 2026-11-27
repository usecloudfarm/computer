import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

/**
 * The claim this package has to earn: a shell that runs on Workers.
 *
 * `@cloudfarm/bash-sandbox` is pure TypeScript and runs there by
 * construction. This one is 3.1 MB of WebAssembly, so whether it does is a
 * question about the platform, not about the code — and only workerd can
 * answer it.
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["src/**/*.workers.test.ts"] },
});
