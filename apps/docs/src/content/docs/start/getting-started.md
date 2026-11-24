---
title: Getting started
description: The three tools an agent gets — search, run and code — and when it reaches for each.
---

Whatever apps you install, an agent sees the same three tools. This is the
whole reason the surface stays small.

## `search`

Finds actions by what you want to do, not by name. It answers with ranked hits
carrying a real TypeScript signature, an example, and whether the action
writes anything.

```text
search("read the comments on a story")

hackernews.getComments
  getComments(input: {
    /** Story id. */ id: number;
    /** 1 to 30. Defaults to 10. */ limit?: number;
  }): { storyId: number; comments: { id: number; by: string; … }[] }
  run("hackernews.getComments", { id: 8863, limit: 10 })
```

The ranking is lexical BM25 over each action's `useCases`, name, summary and
keywords. Deterministic, testable, and no embedding service in a library whose
pitch is "bring your own agent".

:::tip
Constraints a type cannot express — ranges, lengths, defaults — are rendered
into the doc comment. A model that cannot see `max(30)` will guess 50 and
spend a turn finding out.
:::

## `run`

Calls one action by reference.

```ts
run({ ref: "bash", args: { cmd: "wc -l /data/notes.md" } });
run({ ref: "slack.sendMessage", args: { channel: "#eng", text: "shipped" } });
```

The shell is an action like any other — `bash` — not a tool of its own. Every
answer is an envelope:

```json
{ "status": "ok", "value": { "stdout": "3 /data/notes.md\n", "exitCode": 0 } }
{ "status": "error", "error": { "code": "unknown_ref", "message": "…", "hint": "Use `search` to find the right ref." } }
```

An error is a value, not a thrown exception. The agent reads the hint and
tries again instead of losing the turn.

## `code`

Runs JavaScript in an isolate, with `run` and a `fs` in scope. Use it when
steps depend on each other — it is one round trip, and the intermediate values
never leave the isolate.

```js
const stories = run("hackernews.topStories", { limit: 5 }).value.stories;
const rows = stories.map((s) => `${s.score},${s.title}`).join("\n");
fs.writeFileSync("/data/top.csv", `score,title\n${rows}\n`);
return stories.length;
```

Three `run` calls would be three round trips and three results in the
transcript. One `code` call is one of each.

See [Code mode](/concepts/code-mode/) for what is in scope, and
[Limits and safety](/concepts/limits/) for what bounds it.

## Which to reach for

| You want to                                      | Use              |
| ------------------------------------------------ | ---------------- |
| find out what is available                       | `search`         |
| do one thing                                     | `run`            |
| chain several things, or shape data between them | `code`           |
| read one file, quickly                           | `run` with `cat` |
| read and combine several files                   | `code` with `fs` |
