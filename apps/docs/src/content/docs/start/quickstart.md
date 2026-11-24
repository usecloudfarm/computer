---
title: QuickStart
description: A working agent with a filesystem, a shell and an app.
---

## Install

`cloudfarm` is the Computer, the shell and code mode in one install.

```bash
pnpm add cloudfarm
pnpm add @cloudfarm/ai-sdk-toolset ai @ai-sdk/anthropic
```

:::note
There is no `provider` or `codeEngine` option. Which shell runs is decided by
what is installed, and `cloudfarm` installs the fast one.

To choose for yourself — or to keep a Workers bundle down to what it uses —
take the parts instead: `@cloudfarm/computer` is the Computer, and
`@cloudfarm/rbash-sandbox` and `@cloudfarm/qjs-engine` are the shell and the
engine it finds at runtime. See [Packages](/configuration/overview/).
:::

## A computer with a shell

```ts
import { Computer } from "cloudfarm";
import { AISDKToolset } from "@cloudfarm/ai-sdk-toolset";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const computer = new Computer({ toolset: new AISDKToolset() });
const workspace = await computer.createWorkspace("user_id");

const result = await generateText({
  model: anthropic("claude-sonnet-5-5"),
  tools: await workspace.tools(),
  prompt: "Count the lines in /data/notes.md",
});
```

`createWorkspace` takes the user's id. Everything below it — files, shell
state, the session — is scoped to that user, and two users never share a
filesystem.

## Give it files

`workspace.fs` is your program's handle on the same filesystem the agent uses.
Your paths are rooted at `/`; the agent sees them under `/data`.

```ts
await workspace.fs.write("/notes.md", "one\ntwo\nthree\n");

// The agent runs: wc -l /data/notes.md
```

## Make it durable

The default storage is memory, so nothing survives a restart. One option
changes that:

```ts
import { sqliteStorage } from "@cloudfarm/sqlite-storage";

const computer = new Computer({
  toolset: new AISDKToolset(),
  storage: sqliteStorage({ path: ".cloudfarm/workspaces.db" }),
});
```

See [Choosing storage](/guides/storage/) for D1 and S3.

## Add an app

An app contributes actions the agent finds with `search`. It never appears in
the tool list.

```ts
import { slack } from "@cloudfarm/slack";

const computer = new Computer({
  toolset: new AISDKToolset(),
  apps: [slack({ apiKey: process.env.SLACK_TOKEN })],
});
```

## Repair a common slip

Models sometimes call an action as though it were a tool. The SDK rejects an
undeclared tool name before anything runs, which costs the whole turn. One
option turns that into a single bad call:

```ts
import { AISDKToolset, repairToRun } from "@cloudfarm/ai-sdk-toolset";

streamText({
  model,
  tools: await workspace.tools(),
  repairToolCall: repairToRun(),
});
```
