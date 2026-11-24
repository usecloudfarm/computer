---
title: Overview
description: Every package you can configure, what interface it implements, and where it lives.
sidebar:
  order: 1
---

`cloudfarm` installs the Computer, the shell and the engine together, and is
what a new project should take. Everything below is what it pulls in, plus the
parts you add yourself.

```bash
pnpm add cloudfarm
```

The folder a package lives in declares which interface in `@cloudfarm/computer`
it satisfies. The name says it too: `<what>-<role>`.

| Package                         | Role                                    | Notes                             |
| ------------------------------- | --------------------------------------- | --------------------------------- |
| `cloudfarm`                     | the Computer, the shell and the engine  | one install, nothing to wire      |
| `@cloudfarm/computer`           | the Computer, and every interface below | isomorphic: no Node built-ins     |
| `@cloudfarm/rbash`              | the bash interpreter, standalone        | wasm; usable without a Computer   |
| `@cloudfarm/rbash-sandbox`      | the shell                               | the interpreter, as a provider    |
| `@cloudfarm/bash-sandbox`       | the shell                               | `just-bash`, pure TypeScript      |
| `@cloudfarm/qjs-engine`         | code mode                               | QuickJS, in WebAssembly           |
| `@cloudfarm/sqlite-storage`     | storage                                 | local file, Durable Object, or D1 |
| `@cloudfarm/s3-storage`         | storage                                 | any S3-compatible bucket          |
| `@cloudfarm/ai-sdk-toolset`     | toolset                                 | Vercel AI SDK                     |
| `@cloudfarm/slack`              | app                                     | see [Apps](/apps/)                |
| `@cloudfarm/hackernews`         | app                                     | see [Apps](/apps/)                |
| `@cloudfarm/firecrawl`          | app                                     | see [Apps](/apps/)                |
| `@cloudfarm/cloudflare-browser` | app                                     | see [Apps](/apps/)                |
| `@cloudfarm/discord`            | app                                     | see [Apps](/apps/)                |
| `@cloudfarm/github`             | app                                     | see [Apps](/apps/)                |
| `@cloudfarm/jira`               | app                                     | see [Apps](/apps/)                |
| `@cloudfarm/linear`             | app                                     | see [Apps](/apps/)                |
| `@cloudfarm/notion`             | app                                     | see [Apps](/apps/)                |
| `@cloudfarm/sentry`             | app                                     | see [Apps](/apps/)                |
| `@cloudfarm/stripe`             | app                                     | see [Apps](/apps/)                |

Apps keep a bare service name — `@cloudfarm/slack`, not `slack-app`. The
absence of a role suffix is itself the signal.

## What is installed decides what exists

Core does not import the shell or the engine: they depend on core, so a
dependency back would be a cycle. It finds them at runtime instead.

- `rbash-sandbox` installed → it is the shell.
- Only `bash-sandbox` → that is the shell.
- Neither → no `run` tool, rather than a broken one.
- No `qjs-engine` → no `code` tool.
