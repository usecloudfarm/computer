---
title: Testing a computer
description: Scripted shells, seeded filesystems, and the assertions worth writing.
---

## A workspace in three lines

```ts
import { Computer, MemoryStorage } from "@cloudfarm/computer";

const workspace = await new Computer({
  storage: new MemoryStorage({ seed: { "/sales.csv": "region,amount\nemea,1200\n" } }),
}).createWorkspace("tester");
```

## Scripting the shell

`new Computer()` takes no provider, so a test that needs to assert _what
reached the shell_ installs a double through the same seam the real lookup
uses:

```ts
import { fakeSandbox, resetDefaults, setTestDefaults } from "@cloudfarm/computer";

afterEach(resetDefaults);

setTestDefaults({ provider: fakeSandbox({ responses: { "echo hi": { stdout: "hi\n" } } }) });
```

:::note
`setTestDefaults` is deliberately not a `ComputerOptions` field. A test needs
to see what the shell was asked; that was never a reason to let a consumer
swap it in production.
:::

## What is worth asserting

**That an action can be found.** An action the model cannot reach is an action
that does not exist.

```ts
const found = await workspace.search("file a bug");
expect(found.actions[0]?.ref).toBe("linear.createIssue");
```

**That a secret never escapes.** Put a fixture token in `secrets` and assert
it appears in no result, log or error.

```ts
const result = await workspace.code(`return run("app.leak", {}).value;`);
expect(JSON.stringify(result)).not.toContain("hunter2");
```

**That a limit returns rather than hangs.**

```ts
const result = await workspace.code("while (true) {}");
expect(result.outcome).toBe("timeout");
expect(result.limitsHit).toContain("timeoutMs");
```

**That descriptions still say what you think.** They are prompt text: editing
one changes behaviour for every user, so snapshot the ones that matter.

## Running under workerd

Core's suite runs in both pools. If a change reaches for a Node built-in, the
workers run fails — which is the isomorphism guarantee, enforced rather than
documented.

```bash
pnpm test           # node
pnpm test:workers   # workerd, via @cloudflare/vitest-plugin
```
