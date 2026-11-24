---
title: Shells
description: rbash-sandbox and bash-sandbox — what each is, and which you get.
sidebar:
  order: 3
---

Two implementations of the same interface. Whichever is installed is the one
that runs; `rbash-sandbox` wins when both are.

## `@cloudfarm/rbash-sandbox`

A bash interpreter written in Rust and compiled to WebAssembly, running in
your process over the workspace.

```bash
pnpm add @cloudfarm/rbash-sandbox
```

The interpreter itself is a separate package,
[`@cloudfarm/rbash`](https://www.npmjs.com/package/@cloudfarm/rbash), and
works on its own — a sandboxed shell with an in-memory filesystem and no
Computer involved. This package is the adapter that makes it a
`SandboxProvider`; it pulls the interpreter in for you.

All 72 of `just-bash`'s commands, and faster on every shape measured — 1.3× to
5.4× through a whole `exec`, which includes the workspace copy both pay.

```text
awk  grep  rg  sed  cut  sort  uniq  tr  find  tee  xargs  diff  comm  join
base64  md5sum  sha256sum  gzip  tar  jq  yq  xan  sqlite3  html-to-markdown
```

Bounded by default — a runaway loop stops itself — and `curl`/`wget` are
available behind `{ network: true }`. See
[Giving the shell network](/guides/network/).

:::caution
`sqlite3` here is **not SQLite**: the database is JSON and the real tool
cannot open it. It wears the CLI's shape — CREATE/INSERT/SELECT with GROUP BY,
HAVING, ORDER BY and aggregates, UPDATE, DELETE — with no joins, subqueries,
indexes or transactions.
:::

On Workers it needs its module handed in:

```ts
import shell from "@cloudfarm/rbash/wasm";
new Computer({ wasm: { shell } });
```

## `@cloudfarm/bash-sandbox`

`just-bash`: the same shape in pure TypeScript. No wasm to ship and nothing to
hand in on Workers, which makes it the fallback when `wasm.shell` is absent.

Smaller command set, and `curl` only with a `network` config that this package
does not pass — so it has none.
