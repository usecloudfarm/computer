---
title: "@cloudfarm/qjs-engine"
description: Code mode, in a QuickJS isolate.
sidebar:
  order: 4
---

```bash
pnpm add @cloudfarm/qjs-engine
```

QuickJS compiled to WebAssembly, in your process. Install it and the `code`
tool exists; leave it out and the tool is absent rather than broken.

## Why an isolate rather than the sandbox

A script making twelve action calls over a remote sandbox pays twelve network
round trips, which erases the benefit code mode exists to deliver. The isolate
is for glue; the shell is for work.

## Entry points

```ts
import { quickjs } from "@cloudfarm/qjs-engine"; // Node
import { quickjsForWorkers } from "@cloudfarm/qjs-engine/workers"; // Workers
```

On Workers the wasm must be a static import your bundler emits, which is what
`ComputerOptions.wasm.engine` is for.

## Capabilities

|                  |                                                                                |
| ---------------- | ------------------------------------------------------------------------------ |
| `asyncHostCalls` | yes, but serialised — asyncify unwinds the stack per call                      |
| `guestAwait`     | yes, and optional                                                              |
| `interruptible`  | yes — QuickJS self-interrupts, which is what makes a CPU limit work on Workers |
| `memoryCap`      | yes                                                                            |
