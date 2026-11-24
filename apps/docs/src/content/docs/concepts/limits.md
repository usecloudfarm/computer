---
title: Limits and safety
description: What bounds a run, and what an agent cannot reach.
---

## Code mode limits

| Limit            | Default | What it bounds                               |
| ---------------- | ------- | -------------------------------------------- |
| `timeoutMs`      | 15 s    | wall clock, including time inside host calls |
| `cpuTimeoutMs`   | 5 s     | uninterrupted guest CPU                      |
| `memoryBytes`    | 64 MiB  | isolate heap                                 |
| `maxHostCalls`   | 32      | actions one script may call                  |
| `maxResultBytes` | 256 KiB | a single returned value                      |
| `maxTotalBytes`  | 1 MiB   | everything a run returns                     |
| `maxSourceBytes` | 64 KiB  | the script itself                            |

```ts
await workspace.code(source, { limits: { timeoutMs: 60_000, maxHostCalls: 100 } });
```

Two clocks, deliberately. The interrupt handler covers guest CPU; it cannot
fire while the stack is unwound inside a host call, so a separate wall clock
covers that. Without both, one hung upstream call makes a run unkillable.

An overrun is a **structured result**, not an exception:

```json
{ "outcome": "timeout", "limitsHit": ["timeoutMs"], "calls": [ … ] }
```

`maxHostCalls` is reported _into_ the guest, so the script's `catch` and
`finally` still run and partial work is still reported.

## The shell

Bounded by default: a runaway loop stops itself rather than hanging.

```text
$ i=0; while true; do i=$((i+1)); done
bash: loop iteration limit exceeded
```

Recursion and word expansion are capped the same way. This matters most on
Workers, where you cannot terminate a thread — a shell that spins forever is
unrecoverable, so it has to stop itself.

There is no host filesystem: `cat /etc/passwd` and `../../../../etc/shadow`
both find nothing.

## Credentials

Three independent controls:

1. A handler gets `fetch` with the credential **captured in a closure**. It is
   never a value the handler can read or return.
2. The isolate's only authority is the bridge, so there is no object graph
   from guest to host heap.
3. A **redactor** scrubs known secrets and common token shapes from every
   model-facing path — code results, run results, logs, errors — and strips
   `Authorization` and `Cookie` from serialised upstream errors.

```ts
new Computer({ secrets: [process.env.SLACK_TOKEN] });
```

Plus a host allowlist on `AuthorizedFetch`, so a prompt-injected URL cannot
redirect a credentialed request.
