/**
 * The shape from the original brief, typechecked in CI.
 *
 * If this file stops compiling, the public API has drifted from what was
 * designed — which is the point of keeping it in the workspace.
 */
import { Computer } from "@cloudfarm/core";
import { JustBash } from "@cloudfarm/bash";
import { quickjs } from "@cloudfarm/quickjs";
import { slack } from "@cloudfarm/slack";
import { AISDKToolset } from "@cloudfarm/ai";

const computer = new Computer({
  toolset: new AISDKToolset(),
  provider: new JustBash(), // the default shell; swap for @cloudfarm/e2b
  codeEngine: quickjs(), // code mode, in a WebAssembly isolate
  apps: [slack({ apiKey: process.env["SLACK_TOKEN"] ?? "" })],
  secrets: [process.env["SLACK_TOKEN"] ?? ""],
});

const workspace = await computer.createWorkspace("user_id");

// Hand straight to an agent:
//
//   import { generateText } from "ai";
//   const result = await generateText({
//     model,
//     tools: await workspace.tools(),
//     prompt: "Summarise #eng and save it to /notes/eng.md",
//   });
const tools = await workspace.tools();

console.log(`tools: ${Object.keys(tools).join(", ")}`);
console.log(`workspace: ${workspace.info.userId}/${workspace.info.id}`);

await computer.closeAll();
