---
title: "@cloudfarm/computer"
description: The Computer, the workspace, and every interface the others implement.
sidebar:
  order: 2
---

Everything else in the repo implements an interface defined here.

```bash
pnpm add @cloudfarm/computer
```

## What it owns

- `Computer` and `Workspace`
- the action registry, ref dispatch and BM25 search
- code-mode orchestration, limits and the host bridge
- `MemoryStorage` and the `FileSystem` contract
- tool specs, type generation, redaction, clamping

## Isomorphism, enforced

Core has **no `@types/node`** and `"types": []` in its tsconfig, so `node:*`
and `process` fail to typecheck. Lint bans `^node:` imports in `src`. The
whole suite runs under workerd in addition to Node.

That is why platform code lives in leaf packages: `node:sqlite` in
`sqlite-storage/node`, the wasm entry points in the engine and shell.

## Exports worth knowing

```ts
import {
  Computer,
  Workspace,
  MemoryStorage,
  FileNotFoundError,
  normalizePath,
  WORKSPACE_ROOT,
  inSandbox,
  inWorkspace,
  createApp,
  createAction,
  apiKey,
  basic,
  oauth,
  Redactor,
  clampForModel,
  toLargeRef,
  resetDefaults,
  setTestDefaults,
  fakeApp,
  fakeSandbox,
} from "@cloudfarm/computer";
```
