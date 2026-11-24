---
title: Running on Workers
description: What changes on workerd, and the one thing you must pass.
---

`@cloudfarm/computer` has no `@types/node` and no `node:*` imports, and its whole
suite runs under workerd on every commit. That is the guarantee; this page is
what it costs you.

## Hand in the wasm

Workers refuses `WebAssembly.compile` on bytes, so a wasm module has to arrive
as a static import — and only your bundler can emit one.

```ts
import engine from "@jitl/quickjs-wasmfile-release-asyncify/wasm";
import shell from "@cloudfarm/rbash/wasm";

const computer = new Computer({ wasm: { engine, shell } });
```

This is not a choice of engine. It is the same QuickJS and the same shell; only
how the module is obtained differs.

:::caution
Omit `wasm.shell` and the shell falls back to `@cloudfarm/bash-sandbox`, which
is TypeScript and needs no module — but has no `awk`, `sqlite3`, `gzip` or
`curl`. The same code then behaves differently on Workers than on Node. Pass
it, or be deliberate about not passing it.
:::

## A Durable Object

A workspace per object, with storage that needs no configuration:

```ts
import { DurableObject } from "cloudflare:workers";
import { Computer } from "@cloudfarm/computer";
import { sqliteStorage } from "@cloudfarm/sqlite-storage/workers";
import engine from "@jitl/quickjs-wasmfile-release-asyncify/wasm";
import shell from "@cloudfarm/rbash/wasm";

export class Workspace extends DurableObject {
  computer = new Computer({
    storage: sqliteStorage({ storage: this.ctx.storage }),
    wasm: { engine, shell },
  });

  async ask(prompt: string) {
    const workspace = await this.computer.createWorkspace("user");
    return workspace.code(prompt);
  }
}
```

```jsonc
// wrangler.jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "Workspace", "class_name": "Workspace" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Workspace"] }],
}
```

## What you cannot do

- **Block the isolate.** No `Atomics.wait`, no synchronous sleep. It is why
  the shell's network works by restarting a run rather than blocking one — see
  [Giving the shell network](/guides/network/).
- **Terminate a thread.** A runaway script has to stop itself, which is why
  both the isolate and the shell are bounded by default.
