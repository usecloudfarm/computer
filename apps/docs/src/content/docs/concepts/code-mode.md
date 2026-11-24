---
title: Code mode
description: What a script can reach, and why calls are serialised.
---

`code` evaluates JavaScript in a QuickJS isolate with a bridge back to the
host. Reach for it when steps depend on each other.

## What is in scope

```js
run(ref, input); // any action, same envelope as the run tool
fs; // readFileSync, writeFileSync, readdirSync, existsSync, …
(path, os, util); // and require() for the same four
console.log; // captured into the result's logs
```

There is no `fetch` and no network. The isolate's only authority is the
bridge, so an action is the only way out.

```js
const rows = fs.readFileSync("/data/sales.csv", "utf8").trim().split("\n").slice(1);
const total = rows.reduce((sum, line) => sum + Number(line.split(",")[2]), 0);
fs.writeFileSync("/data/total.txt", String(total));
return { rows: rows.length, total };
```

:::note
Paths in code mode are **sandbox** paths, so `/data/sales.csv` — the same
string the shell uses. `FileStat.path` is translated back on the way out, so
`readdirSync("/data")` returns paths you can then read.
:::

## Calls are serialised

QuickJS asyncify unwinds the whole wasm stack for each host call, so two calls
never overlap. `Promise.all` works and runs them one at a time. `await` parses
and is optional — a call without it returns the same value.

This matters for budgeting: five actions at 700 ms each is 3.5 s of wall clock
against a 15 s default.

## The result

```ts
{
  outcome: ("ok" | "error" | "timeout" | "invalid",
    value,
    logs,
    calls,
    limitsHit,
    diagnostics,
    durationMs);
}
```

`calls` is the audit trail — every action the script invoked, with its
duration and whether it failed. A limit overrun is a structured result, not a
thrown error, and partial work is reported.

## When not to use it

One file, one read: `run("bash", { cmd: "cat /data/x.md" })` is cheaper and
reads better in a transcript. Code mode earns its keep from the second step
onwards.
