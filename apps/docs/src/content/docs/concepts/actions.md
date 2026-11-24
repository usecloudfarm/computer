---
title: Actions and refs
description: What an app contributes, how it is found, and what it is handed.
---

An **action** is one thing an app can do. A **ref** is its address:
`slack.sendMessage`, `hackernews.getComments`, or a built-in like `bash`.

Actions are never tools. They are found with `search` and called with `run`,
which is what keeps the tool surface fixed as apps are added.

## Defining one

```ts
import { createApp, createAction } from "@cloudfarm/computer";
import { z } from "zod";

export const notes = createApp({
  id: "notes",
  name: "Notes",
  description: "A scratchpad the agent can search.",
  allowedHosts: ["api.example.com"],
  actions: {
    append: createAction({
      summary: "Add a line to today's note.",
      // What `search` ranks on. Write them as a user would ask.
      useCases: ["jot something down", "add a note", "remember this"],
      keywords: ["note", "scratch", "memo"],
      input: z.object({ text: z.string().min(1).describe("The line to add.") }),
      output: z.object({ path: z.string(), lines: z.number() }),
      example: 'run("notes.append", { text: "ship on Friday" })',
      sideEffects: "write",
      handler: async ({ text }, context) => {
        const path = "/notes/today.md";
        const before = await context.fs.readText(path).catch(() => "");
        const after = `${before}${text}\n`;
        await context.fs.write(path, after);
        return { path, lines: after.trimEnd().split("\n").length };
      },
    }),
  },
});
```

## What a handler gets

```ts
interface ActionContext {
  fetch: AuthorizedFetch; // the credential is in a closure, never a value
  http: HttpClient; // JSON over that fetch, with status-aware errors
  workspace: WorkspaceInfo;
  signal: AbortSignal;
  ref: (data, mime?) => Promise<LargeRef>; // park a big payload
}
```

Note what is absent: no `env`, no credentials as values, no way to reach
another user's workspace. An action that leaks its own token has to work at
it.

## `sideEffects`

`"read" | "write" | "destructive"`. It is surfaced in `search` results so a
model can tell a query from a mutation, and it is the natural hook for an
approval step.

## Writing `useCases` well

They are the main ranking signal. Phrase them the way someone would ask, not
the way the API is named:

```ts
// Good
useCases: ["what are people saying", "read the comments", "summarise the discussion"];

// Weak — the model already knows the method is called getComments
useCases: ["get comments", "comments API"];
```

See [Writing an app](/guides/writing-an-app/) for the whole flow.
