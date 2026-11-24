---
title: Errors and results
description: Why nothing throws at the model, and what it gets instead.
sidebar:
  order: 3
---

Every model-facing path answers with a value. A thrown exception ends a turn;
a structured error is something an agent can read and act on.

```json
{
  "status": "error",
  "error": {
    "code": "invalid_args",
    "message": "Invalid arguments for \"hackernews.getComments\": limit: Too big: expected number to be <=30",
    "retryable": false,
    "hint": "Check the signature from `search`."
  }
}
```

`retryable` distinguishes "this will never work" from "try again" — a 429 or a
timeout is retryable, a schema mismatch is not.

## Limits are results too

```json
{ "outcome": "timeout", "limitsHit": ["timeoutMs"], "calls": [ … ], "logs": [ … ] }
```

`maxHostCalls` is reported _into_ the guest, so a script's `catch` and
`finally` still run and partial work is still reported.

## The one exception

Code mode's `fs` throws, because it is pretending to be Node and that is what
Node does:

```js
try {
  fs.readFileSync("/data/nope");
} catch (e) {
  e.code === "ENOENT";
}
```

Mixing the two conventions in one script is the cost, and it is the right way
round: a script that forgets to check `existsSync` should stop, where one
calling an app's action should be able to branch on the error.

## Redaction

Everything model-facing passes through a redactor: known secrets from
`secrets`, common token shapes, and `Authorization`/`Cookie` stripped from
serialised upstream errors.
