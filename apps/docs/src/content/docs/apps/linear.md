---
title: Linear
description: Issue tracking. Create issues, search them, comment on one, list teams, and read what is assigned to you.
app:
  package: "@cloudfarm/linear"
  icon: "https://cdn.simpleicons.org/linear"
  credential: api-key
  mark: Li
---

## Install

```bash
pnpm add @cloudfarm/linear
```

## Connect

```ts
import { linear } from "@cloudfarm/linear";

const computer = new Computer({
  apps: [
    linear({
      apiKey: process.env.LINEAR_API_KEY,
    }),
  ],
});
```

Create a personal API key in Linear under Settings → Security & access → Personal API keys.

| Option   | Type     | Notes                                            |
| -------- | -------- | ------------------------------------------------ |
| `apiKey` | `string` | Required. A Linear personal API key (lin_api_…). |

Requests may only reach `api.linear.app`.

## What the agent can do

| Action                      | Does                                                                       | Writes |
| --------------------------- | -------------------------------------------------------------------------- | ------ |
| `linear.listTeams`          | List the teams this key can see, with the ids other actions need           | no     |
| `linear.createIssue`        | Open an issue on a team's board                                            | yes    |
| `linear.searchIssues`       | Search issues by text across the workspace                                 | no     |
| `linear.commentOnIssue`     | Add a comment to an issue                                                  | yes    |
| `linear.myIssues`           | Read the issues assigned to the key's own user                             | no     |
| `linear.listIssues`         | List issues, filtered by team, state category or assignee                  | no     |
| `linear.getIssue`           | Read one issue in full, with its description and labels                    | no     |
| `linear.updateIssue`        | Change an issue: its state, assignee, title, priority, estimate or project | yes    |
| `linear.listWorkflowStates` | List a team's workflow states, with the ids an issue move needs            | no     |
| `linear.listUsers`          | List workspace members, with the ids assignment needs                      | no     |
| `linear.listProjects`       | List projects, with their progress and target dates                        | no     |
| `linear.getProject`         | Read one project, with its progress and lead                               | no     |
| `linear.createProject`      | Create a project for one or more teams                                     | yes    |
| `linear.listIssueComments`  | Read the comments on an issue                                              | no     |
| `linear.listLabels`         | List issue labels, with the ids labelling needs                            | no     |
| `linear.addLabelToIssue`    | Add a label to an issue                                                    | yes    |
| `linear.linkUrlToIssue`     | Attach a URL to an issue, e.g. the pull request that fixes it              | yes    |
| `linear.archiveIssue`       | Archive an issue, taking it off the board                                  | yes    |
| `linear.listCycles`         | List cycles (sprints), with their dates and progress                       | no     |
| `linear.me`                 | Read the user the API key belongs to                                       | no     |

```ts
run({ ref: "linear.listTeams", args: {} });
run({ ref: "linear.createIssue", args: { teamId: "…", title: "…" } });
```

## Notes

Linear has no REST API, so every action is one POST to /graphql with a
document written out in the spec. That is a feature for an agent: the
query decides the response shape, so an action returns the five fields a
model needs rather than the forty an issue has.

`createIssue` takes a team id rather than a team key because that is what
the mutation takes; `listTeams` is how an agent gets one, and the two
chain in a single code-mode script.

Upstream API docs: <https://developers.linear.app/docs/graphql/working-with-the-graphql-api>
