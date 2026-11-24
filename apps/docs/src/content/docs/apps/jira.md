---
title: Jira
description: Issue tracking. Search issues with JQL, read one, create issues, comment on them, and list projects.
app:
  package: "@cloudfarm/jira"
  icon: "https://cdn.simpleicons.org/jira"
  credential: basic
  mark: Ji
---

## Install

```bash
pnpm add @cloudfarm/jira
```

## Connect

```ts
import { jira } from "@cloudfarm/jira";

const computer = new Computer({
  apps: [
    jira({
      username: process.env.JIRA_EMAIL,
      password: process.env.JIRA_TOKEN,
      site: "acme",
    }),
  ],
});
```

Create an API token at id.atlassian.com/manage-profile/security/api-tokens, and pass it with the Atlassian account email as `username`. Jira Cloud authenticates the pair over HTTP Basic.

| Option     | Type     | Notes                                                             |
| ---------- | -------- | ----------------------------------------------------------------- |
| `username` | `string` | Required.                                                         |
| `password` | `string` | Required.                                                         |
| `site`     | `string` | Required. Atlassian site name — the "acme" in acme.atlassian.net. |

Requests may only reach `<site>.atlassian.net`.

## What the agent can do

| Action              | Does                                            | Writes |
| ------------------- | ----------------------------------------------- | ------ |
| `jira.searchIssues` | Search issues with JQL                          | no     |
| `jira.getIssue`     | Read one issue by key                           | no     |
| `jira.createIssue`  | Create an issue in a project                    | yes    |
| `jira.addComment`   | Comment on an issue                             | yes    |
| `jira.listProjects` | List projects, with the keys other actions need | no     |

```ts
run({ ref: "jira.searchIssues", args: { jql: "…" } });
run({ ref: "jira.createIssue", args: { projectKey: "…", summary: "…" } });
```

## Notes

Jira Cloud is per-site, so `site` is a constructor option rather than an
argument: it decides the base URL and therefore the egress allowlist, and
a value that decides where a credentialed request may go must not arrive
from a model.

Descriptions and comments are Atlassian Document Format, not markdown.
The spec wraps plain text in the smallest valid document, which is what
an agent wants in the overwhelming majority of cases.

Upstream API docs: <https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/>
