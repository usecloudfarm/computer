# @cloudfarm/notion

Notes and docs. Search the workspace, read a page, create pages, append paragraphs, and query a database.

Generated from `tools/integration-codegen/specs/notion.mjs`. Edit the spec and run
`pnpm gen:integrations`; `src/` is overwritten, so hand edits there are lost.

## Credentials

Create an internal integration at notion.so/my-integrations and copy its secret, then share the pages or databases it should reach with that integration — Notion grants nothing by default, so an unshared page is invisible even with a valid token. See [the upstream docs](https://developers.notion.com/reference/intro).

The credential is held by the auth scheme and applied per request. No action
handler, result, or code-mode script can read it, and `allowedHosts` keeps a
credentialed request from being redirected off `api.notion.com` by a URL that
arrived in a model's arguments.

## Usage

```ts
import { Computer } from "@cloudfarm/computer";
import { notion } from "@cloudfarm/notion";

const computer = new Computer({
  apps: [notion({ apiKey: process.env.NOTION_API_KEY! })],
});
```

## Actions

| ref                           | what it does                                               | effects     |
| ----------------------------- | ---------------------------------------------------------- | ----------- |
| `notion.search`               | Search pages and databases the integration can see.        | read        |
| `notion.getPage`              | Read a page's metadata and properties.                     | read        |
| `notion.createPage`           | Create a page under an existing page.                      | write       |
| `notion.appendParagraph`      | Append a paragraph of text to a page.                      | write       |
| `notion.queryDatabase`        | List rows in a database.                                   | read        |
| `notion.getBlockChildren`     | Read a page's content blocks, in order.                    | read        |
| `notion.appendBlocks`         | Append arbitrary Notion blocks to a page.                  | write       |
| `notion.getBlock`             | Read one block.                                            | read        |
| `notion.updateParagraph`      | Replace the text of a paragraph block.                     | write       |
| `notion.deleteBlock`          | Delete a block, moving it to the trash.                    | destructive |
| `notion.updatePageProperties` | Set properties on a page, such as a database row's fields. | write       |
| `notion.archivePage`          | Archive a page, moving it to the trash.                    | destructive |
| `notion.listComments`         | Read the comments on a page or block.                      | read        |
| `notion.createComment`        | Comment on a page.                                         | write       |
| `notion.getDatabase`          | Read a database's title and its property schema.           | read        |
| `notion.listUsers`            | List the workspace's users.                                | read        |
| `notion.whoAmI`               | Read the integration this token belongs to.                | read        |

Every action goes through `context.http`, so a non-2xx arrives as an `HttpError`
carrying its status: a 429 reaches the model as a retryable rate limit rather
than a permanent fault. Runs on Node **and** Workers — it uses nothing but
`fetch`.
