---
title: Giving the shell network
description: curl in the shell, how it waits without blocking, and what that costs.
---

Off by default. Not disabled — **absent**: `command -v curl` fails and so does
calling it.

```ts
import { rbash } from "@cloudfarm/rbash-sandbox";

setTestDefaults({ provider: rbash({ network: true }) });
```

Requests go through `ComputerHost.fetch`, the allowlisted path everything else
uses, so whatever egress policy is already in force applies unchanged.

```bash
curl -s https://api.example.com/items | jq -r '.[].name'
curl -s -o /data/page.html https://example.com
curl -sf https://example.com/missing    # exit 22, script continues
```

## How it waits

The interpreter is synchronous and a host `fetch` is a promise. Nothing in
wasm may block a Cloudflare isolate, so the usual trick — `Atomics.wait` on a
worker thread — is unavailable.

So the run is **restartable**. When `curl` needs a response it does not have,
it records the request and unwinds. The caller rolls the filesystem back,
awaits the fetch, files the response, and runs the script again from the top.
The replay reaches the same `curl`, finds the answer waiting, and continues.

```bash
# Two requests, three executions of the script, two network calls.
p=$(curl -s https://example.com/next)
curl -s "https://example.com$p" | jq .
```

**Each request is issued exactly once.** Replays are served from the record, so
a `curl -X POST` is not repeated.

:::caution
The cost: a script with _n_ requests runs _n+1_ times, and it must be
deterministic up to each request — the same input producing the same sequence
of URLs. That holds here because there is no clock and the random sources are
seeded, but a script branching on genuine randomness could diverge between
attempts. Capped at 64 requests per command.
:::

## Should you?

The agent already has network through **actions**, where the host controls the
allowlist and every request is in the audit trail. `curl` moves that inside the
shell, where model-written code composes it freely. That is a product decision
before it is a technical one, which is why it is opt-in.
