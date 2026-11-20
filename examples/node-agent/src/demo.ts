/**
 * A runnable walkthrough of everything a Computer gives an agent: a
 * filesystem, a shell, capability search, and code mode calling several
 * capabilities in one go.
 *
 * No API keys needed — the Slack app is pointed at a local stub so the whole
 * thing runs offline.
 */
import { Computer } from "@cloudfarm/core";
import { JustBash } from "@cloudfarm/bash";
import { quickjs } from "@cloudfarm/quickjs";
import { slack } from "@cloudfarm/slack";
import { AISDKToolset } from "@cloudfarm/ai";
import { createServer } from "node:http";

// --- a stand-in Slack, so the demo needs no credentials ---------------------
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("content-type", "application/json");
  if (url.pathname.endsWith("/conversations.list")) {
    response.end(
      JSON.stringify({
        ok: true,
        channels: [
          { id: "C1", name: "general", is_private: false },
          { id: "C2", name: "eng", is_private: false },
        ],
      }),
    );
    return;
  }
  response.end(JSON.stringify({ ok: true, ts: `${Date.now()}.0001`, channel: "C1" }));
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;

// --- the computer -----------------------------------------------------------
const computer = new Computer({
  toolset: new AISDKToolset(),
  provider: new JustBash(),
  codeEngine: quickjs(),
  apps: [slack({ apiKey: "xoxb-demo-token", baseUrl: `http://localhost:${port}` })],
  secrets: ["xoxb-demo-token"],
});
const workspace = await computer.createWorkspace("demo-user");

const heading = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`);

heading("1. the tools an agent sees");
console.log(Object.keys(await workspace.tools()).join(", "));
console.log("(that list does not grow when you install more apps)");

heading("2. a filesystem");
await workspace.fs.write("/notes/todo.md", "- ship code mode\n- write docs\n");
console.log(await workspace.fs.readText("/notes/todo.md"));

heading("3. a shell over the same files");
const shell = await workspace.exec("ls -la /notes && wc -l < /notes/todo.md");
console.log(shell.stdout.trim());

heading("4. capability search");
const found = await workspace.search("tell the team about the release");
for (const capability of found.capabilities.slice(0, 3)) {
  console.log(`  ${capability.ref.padEnd(22)} ${capability.summary}`);
}
console.log("\n  the types handed to the model:\n");
console.log(
  found.types
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n"),
);

heading("5. code mode: several capabilities in one run");
const result = await workspace.code(`
  const { channels } = slack.listChannels({ limit: 10 });
  console.log("found " + channels.length + " channels");

  const posted = [];
  for (const channel of channels) {
    const sent = slack.sendMessage({ channel: channel.name, text: "v1 is out" });
    posted.push(channel.name + " @ " + sent.ts);
  }
  return posted;
`);
console.log(`  status   ${result.status}`);
console.log(`  value    ${JSON.stringify(result.value)}`);
console.log(`  logs     ${result.logs}`);
if (result.error) console.log(`  error    ${result.error.name}: ${result.error.message}`);
console.log(`  calls    ${result.calls.map((call) => call.capability).join(" → ")}`);

heading("6. limits are enforced, not advisory");
const runaway = await workspace.code("while (true) {}", { limits: { cpuTimeoutMs: 250 } });
console.log(`  runaway loop → ${runaway.status}, hit ${runaway.limitsHit.join(", ")}`);

await computer.closeAll();
server.close();
