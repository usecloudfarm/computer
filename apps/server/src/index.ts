import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDefaultRegistry } from "@unsandbox/runtimes";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const studioDist = fileURLToPath(new URL("../../studio/dist", import.meta.url));
const staticRoot = existsSync(studioDist) ? studioDist : undefined;

const app = createApp({
  registry: createDefaultRegistry(),
  ...(staticRoot !== undefined ? { staticRoot } : {}),
});

serve({ fetch: app.fetch, port }, (info) => {
  const where = `http://localhost:${info.port}`;
  console.log(`unsandbox server listening on ${where}`);
  console.log(
    staticRoot
      ? `  studio:  ${where}`
      : "  studio:  not built yet - run `pnpm --filter @unsandbox/studio build`, or use the Vite dev server",
  );
  console.log(`  api:     ${where}/api/runtimes`);
});
