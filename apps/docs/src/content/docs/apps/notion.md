---
title: Notion
description: Notes and docs. Search the workspace, read a page, create pages, append paragraphs, and query a database.
app:
  package: "@cloudfarm/notion"
  icon: "https://cdn.simpleicons.org/notion"
  credential: api-key
  mark: No
---

## Install

```bash
pnpm add @cloudfarm/notion
```

## Connect

```ts
import { notion } from "@cloudfarm/notion";

const computer = new Computer({
  apps: [
    notion({
      apiKey: process.env.NOTION_API_KEY,
    }),
  ],
});
```

Create an internal integration at notion.so/my-integrations and copy its secret, then share the pages or databases it should reach with that integration — Notion grants nothing by default, so an unshared page is invisible even with a valid token.

| Option   | Type     | Notes                                                              |
| -------- | -------- | ------------------------------------------------------------------ |
| `apiKey` | `string` | Required. A Notion internal integration token (ntn_… or secret_…). |

Requests may only reach `api.notion.com`.

## What the agent can do

| Action                        | Does                                                      | Writes |
| ----------------------------- | --------------------------------------------------------- | ------ |
| `notion.search`               | Search pages and databases the integration can see        | no     |
| `notion.getPage`              | Read a page's metadata and properties                     | no     |
| `notion.createPage`           | Create a page under an existing page                      | yes    |
| `notion.appendParagraph`      | Append a paragraph of text to a page                      | yes    |
| `notion.queryDatabase`        | List rows in a database                                   | no     |
| `notion.getBlockChildren`     | Read a page's content blocks, in order                    | no     |
| `notion.appendBlocks`         | Append arbitrary Notion blocks to a page                  | yes    |
| `notion.getBlock`             | Read one block                                            | no     |
| `notion.updateParagraph`      | Replace the text of a paragraph block                     | yes    |
| `notion.deleteBlock`          | Delete a block, moving it to the trash                    | yes    |
| `notion.updatePageProperties` | Set properties on a page, such as a database row's fields | yes    |
| `notion.archivePage`          | Archive a page, moving it to the trash                    | yes    |
| `notion.listComments`         | Read the comments on a page or block                      | no     |
| `notion.createComment`        | Comment on a page                                         | yes    |
| `notion.getDatabase`          | Read a database's title and its property schema           | no     |
| `notion.listUsers`            | List the workspace's users                                | no     |
| `notion.whoAmI`               | Read the integration this token belongs to                | no     |

```ts
run({ ref: "notion.search", args: { query: "…" } });
run({ ref: "notion.createPage", args: { parentPageId: "…", title: "…" } });
```

## Notes

An internal integration token is a plain string, so no OAuth flow is
involved — but access is per page: an agent sees only what the
integration has been shared with. That is a better default than a key
that reads everything, and it is worth saying in the credential prose
because an empty search result is otherwise baffling.

Titles live at different property names across databases, so `search`
reads the conventional `title` property and the row mapping hands back
`properties` untouched for anything else a model needs.

Upstream API docs: <https://developers.notion.com/reference/intro>
