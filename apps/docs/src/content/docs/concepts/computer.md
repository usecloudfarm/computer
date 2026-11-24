---
title: Computer and workspace
description: What a Computer owns, what a workspace is, and how the two relate.
---

A **Computer** is the configuration: storage, apps, a toolset, limits. A
**workspace** is one user's slice of it — their files, their shell, their
session.

```ts
const computer = new Computer({ toolset: new AISDKToolset(), apps: [slack({ apiKey })] });

const ada = await computer.createWorkspace("ada");
const grace = await computer.createWorkspace("grace");
```

`ada` and `grace` never see each other's files. The storage layout makes that
structural rather than a convention: keys are
`<prefix>/<userId>/workspaces/<workspaceId>/`, so a credential scoped to one
user cannot reach another's.

## Options

```ts
new Computer({
  toolset, // adapts tool specs to your framework. Defaults to raw specs.
  storage, // where files live. Defaults to memory.
  apps, // actions the agent can find
  limits, // code mode bounds
  secrets, // literal strings to scrub from anything the model reads
  wasm, // Workers only: { engine?, shell? }
});
```

:::caution
There is no `provider` and no `codeEngine`. The shell is whichever of
`@cloudfarm/rbash-sandbox` / `@cloudfarm/bash-sandbox` is installed, and code
mode is QuickJS. Remote sandboxes were removed; the
[changelog](https://github.com/usecloudfarm/computer/blob/main/.changeset)
records why.
:::

## The workspace surface

```ts
await workspace.tools(); // tool specs for your agent framework
await workspace.run(ref, args); // call one action
await workspace.search(useCase); // find actions
await workspace.code(source); // run a script
await workspace.exec(command); // the shell, directly
workspace.fs; // the filesystem, for your program
```

`Computer` exposes the same surface, delegating to a default workspace, so a
single-tenant script never has to think about workspaces.

## Sessions

Workspaces are resume-or-create on `{ userId, workspaceId }`, and cheap: the
shell and storage connect lazily on first use. That matters on Workers, where
one is created per request.
