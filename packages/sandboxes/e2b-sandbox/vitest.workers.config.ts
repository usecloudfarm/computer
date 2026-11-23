import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { E2B_API_KEY: process.env.E2B_API_KEY ?? "" } },
    }),
  ],
  test: { include: ["src/**/workers.probe.ts"] },
});
