---
title: Apps and integrations
description: The apps that ship, and what each contributes.
sidebar:
  order: 7
---

An app contributes actions the agent finds with `search`. None of them appear
in the tool list. See [Writing an app](/guides/writing-an-app/) to add one.

## `@cloudfarm/slack`

```ts
slack({ apiKey: process.env.SLACK_TOKEN });
```

`sendMessage`, `listChannels`, `searchMessages`, `getThread`.

## `@cloudfarm/hackernews`

```ts
hackernews({});
```

`topStories`, `getStory`, `getComments`, `search`. No credential.

## `@cloudfarm/firecrawl`

```ts
firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
```

Scrape and search the web, returning markdown rather than HTML — a model
reading `&#x27;` and `<p>` wastes context on markup it then has to ignore.

## `@cloudfarm/cloudflare-browser`

```ts
web({ apiToken, accountId });
```

Fetch and render a page through Cloudflare's browser rendering.
