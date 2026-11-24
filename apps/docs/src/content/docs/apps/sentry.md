---
title: Sentry
description: Error tracking. List, read and triage issues, inspect the events behind one, assign and resolve them, and read releases, projects and teams.
app:
  package: "@cloudfarm/sentry"
  icon: "https://cdn.simpleicons.org/sentry"
  credential: api-key
  mark: Se
---

## Install

```bash
pnpm add @cloudfarm/sentry
```

## Connect

```ts
import { sentry } from "@cloudfarm/sentry";

const computer = new Computer({
  apps: [
    sentry({
      apiKey: process.env.SENTRY_API_KEY,
    }),
  ],
});
```

Create an organization auth token in Sentry under Settings → Auth Tokens with the `project:read`, `event:read` and (for triage) `event:write` scopes.

| Option   | Type     | Notes                                                     |
| -------- | -------- | --------------------------------------------------------- |
| `apiKey` | `string` | Required. A Sentry auth token (sntrys_… or a user token). |

Requests may only reach `sentry.io`.

## What the agent can do

| Action                      | Does                                                                  | Writes |
| --------------------------- | --------------------------------------------------------------------- | ------ |
| `sentry.listIssues`         | List a project's issues, most recent first                            | no     |
| `sentry.searchIssues`       | Search issues across every project in an organization                 | no     |
| `sentry.getIssue`           | Read one issue in full, with its first and last occurrence            | no     |
| `sentry.listIssueEvents`    | List recent events for an issue, newest first                         | no     |
| `sentry.getEvent`           | Read one event in full, including its stack trace entries             | no     |
| `sentry.setIssueStatus`     | Resolve, ignore, or reopen an issue                                   | yes    |
| `sentry.assignIssue`        | Assign an issue to a user or team                                     | yes    |
| `sentry.setIssuePriority`   | Set an issue's priority                                               | yes    |
| `sentry.deleteIssue`        | Delete an issue and every event in it. Sentry answers with no content | yes    |
| `sentry.listIssueTagValues` | Break an issue down by a tag, e.g. which browsers or releases it hits | no     |
| `sentry.bulkSetIssueStatus` | Resolve or ignore every issue in a project matching a search          | yes    |
| `sentry.listProjects`       | List an organization's projects, with the slugs other actions need    | no     |
| `sentry.getProject`         | Read one project's settings and platform                              | no     |
| `sentry.listReleases`       | List an organization's releases, newest first                         | no     |
| `sentry.getRelease`         | Read one release, with its commit and deploy counts                   | no     |
| `sentry.createRelease`      | Register a release for one or more projects                           | yes    |
| `sentry.listReleaseCommits` | List the commits that went into a release                             | no     |
| `sentry.listReleaseDeploys` | List the environments a release was deployed to                       | no     |
| `sentry.listTeams`          | List an organization's teams                                          | no     |
| `sentry.listMembers`        | List an organization's members, with the emails assignment needs      | no     |

```ts
run({ ref: "sentry.listIssues", args: { organization: "…", project: "…" } });
run({ ref: "sentry.setIssueStatus", args: { organization: "…", issueId: "…" } });
```

## Notes

Sentry's paths carry trailing slashes and it is strict about them, so the
spec writes them literally rather than trusting a normaliser.

Every issue path is organization-scoped — `organizations/{org}/issues/…`,
not the older bare `issues/…`. The short form still answers, but it is
absent from Sentry's current API description, and an integration should
not depend on an endpoint its vendor no longer documents.

`count` and `userCount` arrive as strings. They are declared as numbers
and coerced, because a model comparing "9" with 10 gets the wrong
answer and a model comparing 9 with 10 does not.

The organization and project are action arguments rather than
constructor options: one token commonly spans several projects, and an
agent that cannot say which one it means is less useful, not safer.

Upstream API docs: <https://docs.sentry.io/api/>
