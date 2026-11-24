---
title: Writing an app
description: From an API you want the agent to reach, to an action it can find.
---

An app is a plain object. There is no registration step and no build plugin.

## 1. Pick the folder

Where a package lives declares what it implements:

```text
packages/integrations/<name>/    App — third-party actions
packages/storage/<name>/         StorageProvider
packages/toolsets/<name>/        Toolset
```

## 2. Declare the credential

Apps never read `process.env`. They take their credential and hand it to the
auth scheme, which puts it in a closure a handler cannot read back.

```ts
import { createApp, createAction, apiKey } from "@cloudfarm/computer";
import { z } from "zod";

export function linear(options: { apiKey: string }) {
  return createApp({
    id: "linear",
    name: "Linear",
    description: "Issues and projects.",
    allowedHosts: ["api.linear.app"],
    auth: apiKey({ value: options.apiKey, header: "authorization" }),
    actions: {/* … */},
  });
}
```

`allowedHosts` is enforced: a prompt-injected URL cannot redirect a
credentialed request somewhere else.

## 3. Write the action

```ts
createAction({
  summary: "Create an issue in a team's backlog.",
  useCases: ["file a bug", "create an issue", "add a ticket"],
  keywords: ["issue", "ticket", "bug", "backlog"],
  input: z.object({
    team: z.string().describe("Team key, like ENG."),
    title: z.string().min(1).max(255),
    description: z.string().optional(),
  }),
  output: z.object({ id: z.string(), url: z.string() }),
  example: 'run("linear.createIssue", { team: "ENG", title: "Fix the thing" })',
  sideEffects: "write",
  handler: async (input, context) => {
    const created = await context.http.post("https://api.linear.app/graphql", {
      query: MUTATION,
      variables: input,
    });
    return { id: created.id, url: created.url };
  },
});
```

:::tip
`.min(1).max(255)` is not decoration. Those bounds are rendered into the
signature the model reads; without them it guesses, and a validator enforcing
a rule the caller cannot see is a trap.
:::

## 4. Keep results small

An action that could return a lot should park it instead of inlining it:

```ts
handler: async (input, context) => {
  const report = await buildLargeReport(input);
  return report.length > 10_000 ? context.ref(report, "text/markdown") : { report };
};
```

## 5. Test it

```ts
import { Computer } from "@cloudfarm/computer";

const workspace = await new Computer({ apps: [linear({ apiKey: "test" })] }).createWorkspace("u");

const found = await workspace.search("file a bug");
expect(found.actions[0]?.ref).toBe("linear.createIssue");
```

Searching for it is the test that matters. An action the model cannot find is
an action that does not exist.
