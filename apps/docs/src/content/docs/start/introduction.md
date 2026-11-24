---
title: Introduction
description: What cloudfarm is, and what an agent can do with it.
---

cloudfarm is a TypeScript library that gives an AI agent a computer to work
on. You keep your own agent loop and your own model; cloudfarm gives that
agent somewhere to put its work and something to do it with.

A **Computer** hands each of your users a workspace containing:

- a **filesystem** that outlives the conversation,
- a **shell** for the things shells are good at,
- the **apps** you connect, reached as _actions_,
- **code mode**, where the agent writes a script instead of a chain of calls.

However many apps you connect, the agent is handed the same three tools —
`search`, `run` and `code` — and finds everything else through them. Your
prompt does not grow as your product does.

## How it works

You create a Computer once, open a workspace per user, and pass that
workspace's tools to the agent loop you already have.

```ts
const computer = new Computer({
  toolset: new AISDKToolset(),
  apps: [slack({ apiKey: process.env.SLACK_TOKEN })],
});

const workspace = await computer.createWorkspace("user_id");

await generateText({ model, tools: await workspace.tools(), prompt });
```

From there the agent works on its own. It describes what it is trying to do,
gets back actions with real TypeScript signatures, and calls the one it
needs — or writes a script when several steps depend on each other.

```text
search("post to a channel")
  → slack.sendMessage(input: { channel: string; text: string }): { ts: string }

run({ ref: "slack.sendMessage", args: { channel: "#eng", text: "shipped" } })
  → { status: "ok", value: { ts: "1712…" } }
```

Anything the agent writes lands in the workspace, and `workspace.fs` is your
program's handle on the same files — so a report it produced this turn is
yours to render, email or diff the moment the turn ends.

## When to use it

Reach for a Computer when the agent needs somewhere to keep things: files that
outlive a turn, a shell to transform them, and a growing set of apps that must
not grow the prompt with them.

It does not run your agent loop, pick your model, or own your HTTP routes. You
bring the loop; a Computer gives it somewhere to work.

It is also not a container. The default shell is a bash interpreter compiled to
WebAssembly, running in your process over the workspace. There is no VM to boot
and no API key to hold — and, equally, no `npm install` and no `python`. If you
need those, a Computer is the wrong layer.

## Where to go next

- [QuickStart](/start/quickstart/) — a working agent in about twenty lines.
- [Getting started](/start/getting-started/) — what `search`, `run` and `code` do.
- [Choosing storage](/guides/storage/) — memory, SQLite, D1 or S3.
