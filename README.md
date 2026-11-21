# cloudfarm

**Computer** — a fast computer with the right tools for every agent.

A Computer gives an agent a workspace: a filesystem for its state, a shell,
apps as plugins, and _code mode_ — where the agent searches for a capability,
gets typed signatures back, and writes code that runs in an isolate.

```ts
import { Computer } from "@cloudfarm/core";
import { JustBash } from "@cloudfarm/bash";
import { quickjs } from "@cloudfarm/quickjs";
import { slack } from "@cloudfarm/slack";
import { AISDKToolset } from "@cloudfarm/ai";

const computer = new Computer({
  toolset: new AISDKToolset(),
  provider: new JustBash(), // the default shell
  codeEngine: quickjs(), // code mode, in WebAssembly
  apps: [slack({ apiKey: process.env.SLACK_TOKEN })],
});

const workspace = await computer.createWorkspace("user_id");

const result = await generateText({
  model,
  tools: await workspace.tools(),
  prompt: "Summarise #eng and save it to /notes/eng.md",
});
```

## Why code mode

An agent with ten apps installed does not get a hundred tools. It gets **six**,
and the list does not grow:

| tool                               | what it does                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `search`                           | find capabilities by intent; returns signatures, examples and a scoped `.d.ts` |
| `code`                             | run JavaScript that calls several capabilities in one go                       |
| `run`                              | call one capability directly — cheaper and auditable                           |
| `bash`                             | run a shell command in the workspace                                           |
| `fs_read` / `fs_write` / `fs_list` | the workspace filesystem                                                       |

Adding an app adds zero tokens to the system prompt. The model finds what it
needs, then writes a script:

```js
const { channels } = run("slack.listChannels", { limit: 10 });
for (const channel of channels) {
  run("slack.sendMessage", { channel: channel.name, text: "v1 is out" });
}
run("fs.write", { path: "/out/posted.txt", content: channels.map((c) => c.name).join("\n") });
return channels.length;
```

One calling convention: `run(ref, input)` inside the isolate is the same ref
the `run` tool takes, so a snippet worked out in code mode replays as a single
tool call unchanged. The workspace filesystem, shell and memory are reachable
the same way.

Calls are **synchronous**. The isolate suspends its whole stack across a host
call, so generated code never touches a promise — which removes the job-queue
machinery and an entire class of bug with it.

**Code is validated before it runs.** Unknown refs, syntax errors and `await`
come back as diagnostics with a line number and a suggestion, having executed
nothing — so a typo on line three never lands two real side effects first:

```
status      invalid
line 3      No capability named "slack.sendMesage". Did you mean: slack.sendMessage?
calls made  0
```

## Packages

| package              | what it is                                                                   | runs on              |
| -------------------- | ---------------------------------------------------------------------------- | -------------------- |
| `@cloudfarm/core`    | `Computer`, `Workspace`, every plugin interface, dispatch, search, redaction | Node **and** Workers |
| `@cloudfarm/bash`    | the default sandbox: bash in TypeScript, no infrastructure                   | Node and Workers     |
| `@cloudfarm/quickjs` | code mode in a WebAssembly isolate                                           | Node and Workers     |
| `@cloudfarm/ai`      | tools for the Vercel AI SDK                                                  | Node and Workers     |
| `@cloudfarm/slack`   | Slack as an app plugin                                                       | Node and Workers     |

`@cloudfarm/core` is isomorphic by construction, not by discipline: it has no
`@types/node`, ESLint refuses `node:*` imports inside it, and **its entire test
suite runs under workerd in CI** as well as Node. That last one is the actual
guarantee.

## Getting started

```sh
pnpm install
pnpm build
pnpm --filter @cloudfarm/example-node-agent demo   # runs offline, no keys
```

The demo walks through the filesystem, the shell, capability search, code mode
chaining several calls, and a runaway loop being stopped at its deadline.

## Design notes

**Zod defines the data.** Every value that crosses a boundary is a Zod schema
with its TypeScript type inferred from it, and app authors write capability
schemas the same way. One definition does three jobs: it validates the model's
arguments host-side, it generates the JSON Schema a tool definition needs, and
it renders the TypeScript the model writes against.

**Credentials are unreachable, not merely hidden.** An app applies its token in
`authorize()`; capability handlers get an already-authorised `fetch` and never
see a value. Generated code is further removed — the isolate's only authority
is one host function, so there is no object graph connecting guest memory to a
token. On top of that, every model-facing value passes a redactor, and each app
declares an egress allowlist so a URL arriving in a model's arguments cannot
redirect a credentialed request.

**Limits return results, not exceptions.** A run that hits its deadline or its
host-call cap reports `status`, which limit it hit, what it logged and which
calls it made, so an agent can see partial work and decide what to do next.

## Scripts

| command                                        | does                                    |
| ---------------------------------------------- | --------------------------------------- |
| `pnpm build`                                   | build every package in dependency order |
| `pnpm test`                                    | run all tests under Node                |
| `pnpm test:workers`                            | run core's suite under workerd          |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | the usual                               |
