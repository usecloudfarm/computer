# @cloudfarm/sentry

Error tracking. List, read and triage issues, inspect the events behind one, assign and resolve them, and read releases, projects and teams.

Generated from `tools/integration-codegen/specs/sentry.mjs`. Edit the spec and run
`pnpm gen:integrations`; `src/` is overwritten, so hand edits there are lost.

## Credentials

Create an organization auth token in Sentry under Settings → Auth Tokens with the `project:read`, `event:read` and (for triage) `event:write` scopes. See [the upstream docs](https://docs.sentry.io/api/).

The credential is held by the auth scheme and applied per request. No action
handler, result, or code-mode script can read it, and `allowedHosts` keeps a
credentialed request from being redirected off `sentry.io` by a URL that
arrived in a model's arguments.

## Usage

```ts
import { Computer } from "@cloudfarm/core";
import { sentry } from "@cloudfarm/sentry";

const computer = new Computer({
  apps: [sentry({ apiKey: process.env.SENTRY_API_KEY! })],
});
```

## Actions

| ref                         | what it does                                                           | effects     |
| --------------------------- | ---------------------------------------------------------------------- | ----------- |
| `sentry.listIssues`         | List a project's issues, most recent first.                            | read        |
| `sentry.searchIssues`       | Search issues across every project in an organization.                 | read        |
| `sentry.getIssue`           | Read one issue in full, with its first and last occurrence.            | read        |
| `sentry.listIssueEvents`    | List recent events for an issue, newest first.                         | read        |
| `sentry.getEvent`           | Read one event in full, including its stack trace entries.             | read        |
| `sentry.setIssueStatus`     | Resolve, ignore, or reopen an issue.                                   | write       |
| `sentry.assignIssue`        | Assign an issue to a user or team.                                     | write       |
| `sentry.setIssuePriority`   | Set an issue's priority.                                               | write       |
| `sentry.deleteIssue`        | Delete an issue and every event in it. Sentry answers with no content. | destructive |
| `sentry.listIssueTagValues` | Break an issue down by a tag, e.g. which browsers or releases it hits. | read        |
| `sentry.bulkSetIssueStatus` | Resolve or ignore every issue in a project matching a search.          | destructive |
| `sentry.listProjects`       | List an organization's projects, with the slugs other actions need.    | read        |
| `sentry.getProject`         | Read one project's settings and platform.                              | read        |
| `sentry.listReleases`       | List an organization's releases, newest first.                         | read        |
| `sentry.getRelease`         | Read one release, with its commit and deploy counts.                   | read        |
| `sentry.createRelease`      | Register a release for one or more projects.                           | write       |
| `sentry.listReleaseCommits` | List the commits that went into a release.                             | read        |
| `sentry.listReleaseDeploys` | List the environments a release was deployed to.                       | read        |
| `sentry.listTeams`          | List an organization's teams.                                          | read        |
| `sentry.listMembers`        | List an organization's members, with the emails assignment needs.      | read        |

Every action goes through `context.http`, so a non-2xx arrives as an `HttpError`
carrying its status: a 429 reaches the model as a retryable rate limit rather
than a permanent fault. Runs on Node **and** Workers — it uses nothing but
`fetch`.
