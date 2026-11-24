---
title: Hacker News
description: Read the front page, open a story's comments, search the archive, look up a user.
app:
  package: "@cloudfarm/hackernews"
  icon: "https://cdn.simpleicons.org/ycombinator"
  credential: none
  mark: HN
  order: 20
---

## Install

```bash
pnpm add @cloudfarm/hackernews
```

## Connect

```ts
import { hackernews } from "@cloudfarm/hackernews";

const computer = new Computer({ apps: [hackernews({})] });
```

No credential — Hacker News' API is public. The empty object is not a
formality: the app still declares an auth scheme, so "needs nothing" is a
decision recorded in the code rather than something left out. That makes this
the app to read first if you are writing your own.

Requests may only reach `hacker-news.firebaseio.com` and `hn.algolia.com`.

## What the agent can do

| Action                   | Does                                          | Writes |
| ------------------------ | --------------------------------------------- | ------ |
| `hackernews.topStories`  | Read the front page, or another of HN's lists | no     |
| `hackernews.getStory`    | Fetch one story by id, with its text          | no     |
| `hackernews.getComments` | Read the top-level comments on a story        | no     |
| `hackernews.search`      | Search the archive by text                    | no     |
| `hackernews.getUser`     | Look up a user's karma and bio                | no     |

```ts
run({ ref: "hackernews.topStories", args: { list: "top", limit: 10 } });
run({ ref: "hackernews.getComments", args: { id: 8863, limit: 10 } });
```
