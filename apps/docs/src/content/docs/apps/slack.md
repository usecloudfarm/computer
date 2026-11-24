---
title: Slack
description: Post messages to channels or DMs, list channels, read threads and search history.
app:
  package: "@cloudfarm/slack"
  credential: api-key
  mark: Sl
  order: 10
---

## Install

```bash
pnpm add @cloudfarm/slack
```

## Connect

```ts
import { slack } from "@cloudfarm/slack";

const computer = new Computer({
  apps: [slack({ apiKey: process.env.SLACK_TOKEN })],
});
```

The token is a Slack bot or user token (`xoxb-…`). It is captured in a
closure and signed into each request by the app itself — a handler never
reads it, and it cannot appear in anything the model sees.

| Option    | Type     | Notes                                                       |
| --------- | -------- | ----------------------------------------------------------- |
| `apiKey`  | `string` | Required. Bot or user token.                                |
| `baseUrl` | `string` | Optional. A proxy or test double; its host is then allowed. |

Requests may only reach `slack.com` and `*.slack.com`.

## What the agent can do

| Action                 | Does                                  | Writes |
| ---------------------- | ------------------------------------- | ------ |
| `slack.sendMessage`    | Post a message to a channel or DM     | yes    |
| `slack.listChannels`   | List channels the token can see       | no     |
| `slack.searchMessages` | Search message history by text        | no     |
| `slack.getThread`      | Fetch every reply in a message thread | no     |

```ts
run({ ref: "slack.sendMessage", args: { channel: "#general", text: "deploy finished" } });
run({ ref: "slack.searchMessages", args: { query: "incident in:#eng" } });
```
