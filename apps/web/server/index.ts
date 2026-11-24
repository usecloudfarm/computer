/**
 * The agent's half of the playground.
 *
 * Everything that matters runs here: the API key, the workspace filesystem,
 * the bash sandbox and the QuickJS isolate. The browser gets a chat endpoint
 * and nothing else — a Computer handed to the client would be a Computer the
 * client could drive directly.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { anthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, streamText, stepCountIs } from "ai";
import type { UIMessage } from "ai";
import { Computer } from "@cloudfarm/core";
import { s3 } from "@cloudfarm/s3-storage";
import { AISDKToolset, repairToRun } from "@cloudfarm/ai-sdk-toolset";
import { hackernews } from "@cloudfarm/hackernews";
import { web } from "@cloudfarm/cloudflare-browser";
import { firecrawl } from "@cloudfarm/firecrawl";
import { reports } from "./reports.ts";

const MODEL = process.env["CLOUDFARM_MODEL"] ?? "claude-sonnet-5-5";
const PORT = Number(process.env["PORT"] ?? 8787);

if (!process.env["ANTHROPIC_API_KEY"]) {
  console.error(
    "Set ANTHROPIC_API_KEY first:\n" +
      '  echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" > apps/web/.env\n' +
      "  pnpm --filter @cloudfarm/web dev",
  );
  process.exit(1);
}

// Hacker News needs no credentials, so the playground has a real third-party
// app out of the box — not a stub pretending to be one.
/**
 * Reading the open web needs a Cloudflare account, so it is added only when
 * one is configured. An app that cannot work is worse than an absent one: the
 * model would find it with `search` and then fail on every call.
 */
const browser =
  process.env["CLOUDFLARE_API_TOKEN"] && process.env["CLOUDFLARE_ACCOUNT_ID"]
    ? [
        web({
          apiKey: process.env["CLOUDFLARE_API_TOKEN"],
          accountId: process.env["CLOUDFLARE_ACCOUNT_ID"],
        }),
      ]
    : [];

const search = process.env["FIRECRAWL_API_KEY"]
  ? [firecrawl({ apiKey: process.env["FIRECRAWL_API_KEY"] })]
  : [];

/**
 * R2 as the workspace filesystem, when the keys are there.
 *
 * Without it the workspace is in memory and every file dies with the process,
 * which makes the playground feel like a demo. With it, `sales.csv` is an
 * object in a bucket and is still there after a restart.
 */
const storage =
  process.env["R2_ACCOUNT_ID"] && process.env["R2_ACCESS_KEY_ID"]
    ? s3({
        bucket: process.env["R2_BUCKET"] ?? "cloudfarm",
        endpoint: `https://${process.env["R2_ACCOUNT_ID"]}.r2.cloudflarestorage.com`,
        accessKeyId: process.env["R2_ACCESS_KEY_ID"],
        secretAccessKey: process.env["R2_SECRET_ACCESS_KEY"] ?? "",
        // The bucket is already called cloudfarm; a `cloudfarm/` folder inside
        // it would only say so twice.
        prefix: "",
      })
    : undefined;

const computer = new Computer({
  toolset: new AISDKToolset(),
  ...(storage ? { storage } : {}),
  apps: [reports, hackernews({}), ...browser, ...search],
});

/**
 * One workspace for the whole process.
 *
 * A real deployment keys this by user — `computer.createWorkspace(userId)` —
 * so two people never share a filesystem. The playground is single-user by
 * design, because seeing your own file survive between turns is the point.
 */
const workspace = await computer.createWorkspace("playground");

// Seeded only when absent. With R2 behind the workspace the file survives a
// restart, and overwriting it every boot would throw away whatever the agent
// did to it last time.
if (!(await workspace.fs.stat("/sales.csv"))) {
  await workspace.fs.write(
    "/sales.csv",
    [
      "region,rep,amount",
      "emea,ada,1200",
      "emea,grace,800",
      "amer,alan,4300",
      "amer,katherine,2200",
      "apac,joan,150",
    ].join("\n") + "\n",
  );
}

const SYSTEM = [
  "You drive a computer: a workspace with a filesystem, a shell, and actions",
  "you discover with `search` rather than being handed up front.",
  "",
  "Prefer one `code` call over a string of `run` calls when steps depend on",
  "each other — it is a single round trip and the intermediate values stay",
  "in the isolate. Use `search` first when you do not know an action's ref.",
  "Say what you did in a sentence or two; the tool calls are already visible",
  "to the user, so do not narrate them step by step.",
  "",
  "The workspace is your memory. Keep what you learn about the user in",
  "/memory/*.md — preferences, context, decisions — and read it back when a",
  "task depends on it. Files persist between sessions; your context does not.",
].join("\n");

const app = new Hono();

app.post("/api/chat", async (context) => {
  const { messages } = await context.req.json<{ messages: UIMessage[] }>();

  const result = streamText({
    model: anthropic(MODEL),
    system: SYSTEM,
    messages: await convertToModelMessages(messages),
    tools: await workspace.tools(),
    stopWhen: stepCountIs(16),
    // A model that calls `bash` as a tool of its own gets the call rewritten
    // into `run` rather than losing the turn to an undeclared tool name.
    repairToolCall: repairToRun(),
    onError: ({ error }) => console.error("[chat]", error),
  });

  return result.toUIMessageStreamResponse();
});

/**
 * Everything the side panels show, in one round trip.
 *
 * The filesystem changes as the agent works, so the UI refetches this after
 * each turn rather than trying to mirror writes it only partly observes.
 */
app.get("/api/workspace", async (context) => {
  // `workspace.fs` rather than `run("fs.list")`: the filesystem is an API for
  // the program embedding a Computer, and the agent reaches files through the
  // shell. The panel is the program, not the agent.
  const files = [];
  for await (const entry of workspace.fs.list("/")) files.push(entry);
  const apps = await workspace.run("apps.list", {});

  return context.json({
    files,
    apps: apps.status === "ok" ? (apps.value as { apps: unknown[] }).apps : [],
    tools: workspace.toolSpecs(),
  });
});

/** One file's contents, for the explorer's preview. */
app.get("/api/file", async (context) => {
  const path = context.req.query("path");
  if (!path) return context.json({ error: "path is required" }, 400);

  try {
    return context.json({ path, content: await workspace.fs.readText(path) });
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : String(error) }, 404);
  }
});

/** Lets the UI name the model it is talking to without hardcoding it. */
app.get("/api/info", (context) => context.json({ model: MODEL, workspace: workspace.info.id }));

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`\x1b[1mcloudfarm web\x1b[0m  api on http://localhost:${port}  model ${MODEL}`);
});
