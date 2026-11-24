---
title: Web
description: Read pages from the open web — markdown, elements by CSS selector, links, and screenshots.
app:
  package: "@cloudfarm/cloudflare-browser"
  icon: "https://cdn.simpleicons.org/cloudflare"
  credential: api-token
  mark: Wb
  order: 40
---

## Install

```bash
pnpm add @cloudfarm/cloudflare-browser
```

## Connect

```ts
import { web } from "@cloudfarm/cloudflare-browser";

const computer = new Computer({
  apps: [
    web({
      apiKey: process.env.CLOUDFLARE_API_TOKEN,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    }),
  ],
});
```

| Option      | Type     | Notes                                                     |
| ----------- | -------- | --------------------------------------------------------- |
| `apiKey`    | `string` | Required. A Cloudflare token with **Browser Run - Edit**. |
| `accountId` | `string` | Required. It is part of the dashboard URL.                |
| `baseUrl`   | `string` | Optional. For a test double.                              |

Requests may only reach `api.cloudflare.com`.

The app is `web`, not `browser`: it answers one page per call rather than
holding a session across calls. A stateful browser is a different thing, and
the `browser` namespace is reserved for it.

## What the agent can do

| Action           | Does                                              | Writes |
| ---------------- | ------------------------------------------------- | ------ |
| `web.read`       | Read a page as markdown, with JavaScript rendered | no     |
| `web.scrape`     | Extract elements from a page by CSS selector      | no     |
| `web.links`      | List the links on a page                          | no     |
| `web.screenshot` | Capture a screenshot, saved into the workspace    | no     |

```ts
run({ ref: "web.read", args: { url: "https://example.com" } });
run({ ref: "web.screenshot", args: { url: "https://example.com", fullPage: true } });
```

A screenshot is written to the workspace and answered as a ref — bytes never
pass through the transcript.
