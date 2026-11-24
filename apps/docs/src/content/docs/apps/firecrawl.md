---
title: Firecrawl
description: Search the web, read any page as markdown, and list every URL on a site. Renders JavaScript.
app:
  package: "@cloudfarm/firecrawl"
  credential: api-key
  mark: Fc
  order: 30
---

## Install

```bash
pnpm add @cloudfarm/firecrawl
```

## Connect

```ts
import { firecrawl } from "@cloudfarm/firecrawl";

const computer = new Computer({
  apps: [firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY })],
});
```

| Option    | Type     | Notes                               |
| --------- | -------- | ----------------------------------- |
| `apiKey`  | `string` | Required. A Firecrawl key (`fc-…`). |
| `baseUrl` | `string` | Optional. For a test double.        |

Requests may only reach `api.firecrawl.dev`.

## What the agent can do

| Action             | Does                                                | Writes |
| ------------------ | --------------------------------------------------- | ------ |
| `firecrawl.search` | Search the web and get back ranked results          | no     |
| `firecrawl.scrape` | Read one page as markdown, with JavaScript rendered | no     |
| `firecrawl.map`    | List the URLs on a site, without reading each page  | no     |

```ts
run({ ref: "firecrawl.search", args: { query: "cloudflare browser rendering pricing", limit: 5 } });
run({ ref: "firecrawl.scrape", args: { url: "https://docs.firecrawl.dev" } });
```

Pages come back as markdown rather than HTML: a model reading `&#x27;` and
`<p>` spends context on markup it then has to ignore. A long page is written
to the workspace and answered as a ref, so a single scrape cannot flood the
turn.
