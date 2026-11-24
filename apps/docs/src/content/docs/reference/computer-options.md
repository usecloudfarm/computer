---
title: ComputerOptions
description: Every option, its default, and why some are missing.
sidebar:
  order: 1
---

```ts
new Computer({
  toolset, // Toolset<T>        — defaults to raw specs
  storage, // StorageProvider   — defaults to MemoryStorage
  apps, // readonly App[]
  limits, // Partial<CodeLimits>
  secrets, // readonly string[] — scrubbed from anything the model reads
  wasm, // { engine?, shell? } — Workers only
  now, // () => number      — for tests
});
```

## `wasm`

Workers refuses `WebAssembly.compile` on bytes, so a module must arrive as a
static import only your bundler can emit.

```ts
import engine from "@jitl/quickjs-wasmfile-release-asyncify/wasm";
import shell from "@cloudfarm/rbash-sandbox/wasm";

new Computer({ wasm: { engine, shell } });
```

On Node, omit it: both load their own `.wasm` from disk.

## What is deliberately absent

**`provider`** and **`codeEngine`** were removed. Which shell runs is decided
by what is installed; code mode is QuickJS and only QuickJS.

Remote sandboxes — E2B, Vercel and two others — were pluggable here and are
gone. What they cost was never the code that talked to them: it was two
filesystems and a sync around every command to pretend they were one, a second
code engine, bucket credentials handed to a machine running model-written
code, and two dialects of the same `fs`. What they bought was `npm` and
`python`.

`setTestDefaults()` is the seam `provider` used to be, for tests only.
