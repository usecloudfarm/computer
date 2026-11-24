# @cloudfarm/jira

Issue tracking. Search issues with JQL, read one, create issues, comment on them, and list projects.

Generated from `tools/integration-codegen/specs/jira.mjs`. Edit the spec and run
`pnpm gen:integrations`; `src/` is overwritten, so hand edits there are lost.

## Credentials

Create an API token at id.atlassian.com/manage-profile/security/api-tokens, and pass it with the Atlassian account email as `username`. Jira Cloud authenticates the pair over HTTP Basic. See [the upstream docs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/).

The credential is held by the auth scheme and applied per request. No action
handler, result, or code-mode script can read it, and `allowedHosts` keeps a
credentialed request from being redirected off `{site}.atlassian.net` by a URL that
arrived in a model's arguments.

## Usage

```ts
import { Computer } from "@cloudfarm/computer";
import { jira } from "@cloudfarm/jira";

const computer = new Computer({
  apps: [
    jira({
      username: process.env.JIRA_EMAIL!,
      password: process.env.JIRA_API_TOKEN!,
      site: "acme",
    }),
  ],
});
```

## Actions

| ref                 | what it does                                     | effects |
| ------------------- | ------------------------------------------------ | ------- |
| `jira.searchIssues` | Search issues with JQL.                          | read    |
| `jira.getIssue`     | Read one issue by key.                           | read    |
| `jira.createIssue`  | Create an issue in a project.                    | write   |
| `jira.addComment`   | Comment on an issue.                             | write   |
| `jira.listProjects` | List projects, with the keys other actions need. | read    |

Every action goes through `context.http`, so a non-2xx arrives as an `HttpError`
carrying its status: a 429 reaches the model as a retryable rate limit rather
than a permanent fault. Runs on Node **and** Workers — it uses nothing but
`fetch`.
