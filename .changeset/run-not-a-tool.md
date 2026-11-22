---
"@cloudfarm/core": patch
"@cloudfarm/ai-sdk-toolset": minor
---

Stop models calling `bash` as a tool of its own.

A computer's actions are refs reached through `run`, with one exception that
is not visible from the outside: `code` and `fs` are tools _as well as_ refs.
Given those two, "and `bash`" is the reasonable generalisation — and the old
`run` description invited it, listing `'bash' for the shell ({ cmd })`
alongside two names that really were tools in the same request. An undeclared
tool name is rejected before anything executes, so the slip cost a whole turn.

`run`'s description now shows refs in call position — `{ ref: 'bash', args:
{ cmd } }` — so a ref can never be read as a tool name, and says outright that
the shell has no tool of its own.

`@cloudfarm/ai-sdk-toolset` gains `repairToRun()` for the other half, since a description
cannot make a model infallible:

```ts
streamText({ model, tools: await workspace.tools(), repairToolCall: repairToRun() });
```

It rewrites a call to an undeclared tool into `run` for that ref. Wrong
guesses are cheap — dispatch answers an unknown ref with an error envelope
carrying a hint, which the model can act on, where a dead turn gives it
nothing. It repairs the name only: malformed _arguments_ raise
`InvalidToolInputError`, which is a real schema mismatch worth surfacing.
