/**
 * A real agent, driving a real Computer.
 *
 * Claude gets the six tools a workspace exposes and a task it cannot finish in
 * one step: read a file, compute something, write the answer back. Every tool
 * call is printed as it happens, so you can watch which it reaches for — and
 * in particular whether it takes the single `code` round trip or a string of
 * `run` calls.
 *
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   pnpm --filter @cloudfarm/example-node-agent agent
 *   pnpm --filter @cloudfarm/example-node-agent agent "your own task here"
 */
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { Computer } from "@cloudfarm/core";
import { AISDKToolset } from "@cloudfarm/ai";
import { z } from "zod";
import type { App } from "@cloudfarm/core";

if (!process.env["ANTHROPIC_API_KEY"]) {
  console.error(
    "Set ANTHROPIC_API_KEY first:\n" +
      "  export ANTHROPIC_API_KEY=sk-ant-...\n" +
      "  pnpm --filter @cloudfarm/example-node-agent agent",
  );
  process.exit(1);
}

const MODEL = process.env["CLOUDFARM_MODEL"] ?? "claude-sonnet-5-5";

/**
 * A stand-in reporting app, so the run needs no third-party credentials. It
 * is a real app plugin: Zod schemas, use cases for search, a handler.
 */
const reports: App = {
  id: "reports",
  name: "Reports",
  description: "Publishes finished reports to the team.",
  allowedHosts: [],
  authorize: (request) => request,
  capabilities: () => [
    {
      name: "publish",
      summary: "Publish a report so the team can read it.",
      useCases: ["publish a report", "share results", "send the summary to the team"],
      input: z.object({
        title: z.string().describe("Short title for the report."),
        body: z.string().describe("Markdown body."),
      }),
      output: z.object({ url: z.string() }),
      example: 'run("reports.publish", { title: "Q4", body: "# Q4\\n…" })',
      sideEffects: "write",
      handler: async (input) => {
        const { title } = input as { title: string };
        published.push(title);
        return { url: `https://reports.internal/${encodeURIComponent(title)}` };
      },
    },
  ],
};
const published: string[] = [];

// Nothing is passed for `provider` or `codeEngine`: bash and QuickJS are the
// defaults when their packages are installed.
const computer = new Computer({
  toolset: new AISDKToolset(),
  apps: [reports],
});

const workspace = await computer.createWorkspace("demo-user");

// Seed the workspace with something worth processing.
await workspace.fs.write(
  "/data/sales.csv",
  [
    "region,rep,amount",
    "emea,ada,1200",
    "emea,grace,800",
    "amer,alan,4300",
    "amer,katherine,2200",
    "apac,joan,150",
  ].join("\n") + "\n",
);

const task =
  process.argv.slice(2).join(" ") ||
  "Read /data/sales.csv from the workspace. Work out the total per region, " +
    "write a short markdown summary to /out/summary.md, and publish it with " +
    "the title 'Regional sales'. Tell me the winning region when you are done.";

console.log(`\x1b[1mmodel\x1b[0m   ${MODEL}`);
console.log(`\x1b[1mtask\x1b[0m    ${task}\n`);

const started = Date.now();
let step = 0;

const result = await generateText({
  model: anthropic(MODEL),
  tools: await workspace.tools(),
  stopWhen: stepCountIs(12),
  prompt: task,
  onStepFinish: ({ toolCalls, toolResults }) => {
    step += 1;
    for (const [index, call] of toolCalls.entries()) {
      const input = JSON.stringify(call.input);
      console.log(
        `\x1b[90mstep ${step}\x1b[0m \x1b[36m${call.toolName}\x1b[0m ` +
          (input.length > 160 ? input.slice(0, 160) + "…" : input),
      );
      const output = toolResults[index]?.output as { status?: string } | undefined;
      if (output?.status === "error") {
        console.log(`        \x1b[31m↳ ${JSON.stringify(output)}\x1b[0m`);
      }
    }
  },
});

console.log(`\n\x1b[1manswer\x1b[0m  ${result.text.trim()}`);
console.log(
  `\x1b[90m${step} steps, ${result.usage.totalTokens ?? "?"} tokens, ${Date.now() - started}ms\x1b[0m`,
);

// What the agent actually left behind.
console.log("\n\x1b[1mworkspace\x1b[0m");
for await (const entry of workspace.fs.list("/")) {
  if (entry.type === "file") console.log(`  ${entry.path} (${entry.size}b)`);
}
if (published.length > 0) console.log(`\n\x1b[1mpublished\x1b[0m  ${published.join(", ")}`);

await computer.closeAll();
