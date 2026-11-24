# cloudfarm

**Computer** — a fast computer with the right tools for every agent.

A Computer gives an agent a workspace: a filesystem for its state, a shell,
apps as plugins, and _code mode_ — where the agent searches for an action,
gets typed signatures back, and writes code that runs in an isolate.

```ts
import { Computer } from "@cloudfarm/computer";
import { slack } from "@cloudfarm/slack";
import { AISDKToolset } from "@cloudfarm/ai-sdk-toolset";

// The shell and code mode are not options: install
// @cloudfarm/bash-sandbox and @cloudfarm/qjs-engine and they are there.
const computer = new Computer({
  toolset: new AISDKToolset(),
  apps: [slack({ apiKey: process.env.SLACK_TOKEN })],
});

const workspace = await computer.createWorkspace("user_id");

const result = await generateText({
  model,
  tools: await workspace.tools(),
  // `/data` is the workspace inside the shell; `/notes/eng.md` to the host.
  prompt: "Summarise #eng and save it to /data/notes/eng.md",
});
```

## The shell and code mode are not configurable

The shell is `just-bash` and code mode is QuickJS. There is no option to pass
either one, and nothing else to pass instead.

```ts
new Computer(); // bash + QuickJS, nothing to decide
```

Both are found at runtime rather than imported, because both packages depend on
core and a dependency back would be a cycle. Install
`@cloudfarm/bash-sandbox` and `@cloudfarm/qjs-engine` and the `run` and `code`
tools exist; leave one out and that tool is absent rather than broken.

Remote sandboxes — E2B, Vercel, and two others — used to be pluggable here.
They are gone. What they cost was not the code to talk to them but everything
underneath: two filesystems to reconcile, a copy sync around every command, an
engine that ran inside the sandbox, bucket credentials handed to a machine
running model-written code, and a second code-mode dialect to keep in step
with the first. What they bought was `npm` and `python`. `just-bash` in this
process starts in a millisecond and shares one filesystem with the workspace;
the microVM took a second to boot and 1.6s per `code()` call, with a tail into
the tens of seconds.

The shell is `@cloudfarm/rbash-sandbox` when it is installed — bash compiled
to WebAssembly, covering every command `just-bash` has and faster on all of
them — and `@cloudfarm/bash-sandbox` otherwise. Which one runs is decided by
what is installed, not by what you pass.

On Workers, hand in the wasm — not a choice, but the one thing only your
bundler can do:

```ts
import engine from "@jitl/quickjs-wasmfile-release-asyncify/wasm";
import shell from "@cloudfarm/rbash-sandbox/wasm";
new Computer({ wasm: { engine, shell } });
```

Omit `shell` there and the shell falls back to `@cloudfarm/bash-sandbox`,
which is TypeScript and needs no module.

On Cloudflare Workers, configure the engine explicitly:
`codeEngine: quickjsForWorkers(wasmModule)`. The wasm has to be a static
import, which only your own bundler can do.

## Why code mode

An agent with ten apps installed does not get a hundred tools. It gets
**three**, and the list does not grow:

| tool     | what it does                                                              |
| -------- | ------------------------------------------------------------------------- |
| `search` | find actions by intent; returns signatures, examples and a scoped `.d.ts` |
| `code`   | run JavaScript that calls several actions in one go                       |
| `run`    | run one action — an app's, or the computer's own (`bash`, `apps.list`)    |

`search` finds, `code` chains, `run` does. Everything else is an action behind
`run`, listing what is installed included — ask `search` for "what can you do".

The shell is not a tool of its own. `bash` is an action **of the computer**,
found with `search` and called with `run`, exactly like `slack.sendMessage` —
because running the shell is running something in the computer.

Neither is the filesystem. Files are what a shell is for: `cat`, `grep`, `ls`
and a heredoc cover what a dedicated tool did, so `run`'s description teaches
those instead — along with how to stay inside a context window, since `cat` on
an unsized file is the cheapest way a model has to fill its own. `fs.read`,
`fs.write` and `fs.list` remain as refs, for content that would be awkward to
quote and for code mode, which has nothing else to call.

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
line 3      No action named "slack.sendMesage". Did you mean: slack.sendMessage?
calls made  0
```

## Packages

| package                     | what it is                                                                   | runs on              |
| --------------------------- | ---------------------------------------------------------------------------- | -------------------- |
| `@cloudfarm/computer`       | `Computer`, `Workspace`, every plugin interface, dispatch, search, redaction | Node **and** Workers |
| `@cloudfarm/bash-sandbox`   | the default sandbox: bash in TypeScript, no infrastructure                   | Node and Workers     |
| `@cloudfarm/qjs-engine`     | code mode in a WebAssembly isolate                                           | Node and Workers     |
| `@cloudfarm/ai-sdk-toolset` | tools for the Vercel AI SDK                                                  | Node and Workers     |
| `@cloudfarm/slack`          | Slack as an app plugin                                                       | Node and Workers     |

`@cloudfarm/computer` is isomorphic by construction, not by discipline: it has no
`@types/node`, oxlint refuses `node:*` imports inside it, and **its entire test
suite runs under workerd in CI** as well as Node. That last one is the actual
guarantee.

## Getting started

```sh
pnpm install
pnpm build
pnpm --filter @cloudfarm/example-node-agent demo   # runs offline, no keys
```

The demo walks through the filesystem, the shell, action search, code mode
chaining several calls, and a runaway loop being stopped at its deadline.

To watch a real model drive it:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter @cloudfarm/example-node-agent agent
pnpm --filter @cloudfarm/example-node-agent agent "your own task"
```

Claude gets the five tools and a task it cannot finish in one step — read a CSV
from the workspace, total it by region, write a summary, publish it. Every tool
call is printed as it happens, so you can see which it reaches for.

## Design notes

**Zod defines the data.** Every value that crosses a boundary is a Zod schema
with its TypeScript type inferred from it, and app authors write action
schemas the same way. One definition does three jobs: it validates the model's
arguments host-side, it generates the JSON Schema a tool definition needs, and
it renders the TypeScript the model writes against.

**Credentials are unreachable, not merely hidden.** An app applies its token in
`authorize()`; action handlers get an already-authorised `fetch` and never
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
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | the usual (`lint` is oxlint)            |
| `pnpm check`                                   | all of the above, packages and examples |

`pnpm check` is the gate: run it after any change of substance. It covers
`examples/` too, so a change that breaks the brief's own snippet fails here
rather than in CI.
