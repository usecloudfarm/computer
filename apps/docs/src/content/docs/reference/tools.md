---
title: Tool specs
description: The exact shape an agent is handed.
sidebar:
  order: 2
---

```ts
workspace.toolSpecs(); // the raw specs
await workspace.tools(); // the same, through your Toolset
```

Three, always: `search`, `run`, `code`. `code` is absent when no engine is
installed; `run` loses the `bash` ref when no shell is.

## `search`

```ts
{ useCase: string; limit?: number; app?: string }
```

Answers ranked hits with `ref`, `summary`, `signature`, `example`,
`sideEffects` and `auth`.

## `run`

```ts
{ ref: string; args?: Json }
```

Answers the envelope:

```ts
{ status: "ok"; value: Json }
{ status: "error"; error: { code: RunErrorCode; message: string; retryable: boolean; hint?: string } }
```

| `code`              | Means                                               |
| ------------------- | --------------------------------------------------- |
| `unknown_ref`       | no action by that name — the hint names near misses |
| `invalid_args`      | input failed the action's schema                    |
| `action_failed`     | the handler threw                                   |
| `upstream_rejected` | the API answered with an error                      |
| `unauthorized`      | credential missing or rejected                      |
| `egress_denied`     | a host outside `allowedHosts`                       |

## `code`

```ts
{
  source: string;
}
```

Answers a `CodeResult`:

```ts
{
  outcome: "ok" | "error" | "timeout" | "invalid",
  value?: Json,
  logs: string[],
  calls: { action: string; ok: boolean; durationMs: number }[],
  limitsHit: string[],
  diagnostics: Diagnostic[],
  durationMs: number,
}
```

## Descriptions are prompt text

A tool's description ships to the model on every request. Editing one changes
behaviour for every consumer, which is why they are treated as API: reviewed
as carefully as a signature, and snapshotted in tests.

The shell's description is assembled from the provider's own, so it names what
that shell actually has — and what it does not.
