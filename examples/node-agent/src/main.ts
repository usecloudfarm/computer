/**
 * The shape from the original brief, typechecked in CI.
 *
 * If this file stops compiling, the public API has drifted from what was
 * designed — which is the point of keeping it in the workspace.
 */
import { Computer } from "@cloudfarm/computer";
import { slack } from "@cloudfarm/slack";
import { AISDKToolset } from "@cloudfarm/ai-sdk-toolset";

const computer = new Computer({
  toolset: new AISDKToolset(),
  apps: [slack({ apiKey: process.env["SLACK_TOKEN"] ?? "" })],
  secrets: [process.env["SLACK_TOKEN"] ?? ""],
  // provider defaults to @cloudfarm/bash-sandbox and codeEngine to @cloudfarm/qjs-engine
  // when those packages are installed. Pass your own — `new E2B({ apiKey })` —
  // to swap either, or `null` to turn it off.
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
