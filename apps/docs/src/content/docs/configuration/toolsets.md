---
title: "@cloudfarm/ai-sdk-toolset"
description: Tool specs as Vercel AI SDK tools.
sidebar:
  order: 6
---

```bash
pnpm add @cloudfarm/ai-sdk-toolset ai
```

```ts
import { AISDKToolset, repairToRun } from "@cloudfarm/ai-sdk-toolset";

const computer = new Computer({ toolset: new AISDKToolset() });

streamText({
  model,
  tools: await workspace.tools(),
  repairToolCall: repairToRun(),
});
```

`ai` is an optional peer: this package emits plain objects rather than calling
`tool()`, which has no runtime behaviour anyway.

## `repairToRun`

A model that has been handed `code` reasonably generalises to calling `bash`
the same way. The SDK rejects an undeclared tool name before anything runs,
which costs the whole turn.

`repairToRun` rewrites `bash({ cmd })` into `run({ ref: "bash", args: { cmd } })`
— a faithful reading, and safe when the guess is wrong: dispatch answers an
unknown ref with an error carrying a hint the model can act on.

It repairs the **name** only. Malformed _arguments_ raise
`InvalidToolInputError`, and guessing at a fix there would hide a real schema
mismatch.

## Writing your own

```ts
interface Toolset<T> {
  materialize(specs: readonly ToolSpec[], invoke: Invoke): T;
}
```

A `ToolSpec` is a name, a description and a JSON Schema. `invoke` takes the
tool name and its input and answers the envelope.
