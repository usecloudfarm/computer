# @cloudfarm/linear

Issue tracking. Create issues, search them, comment on one, list teams, and read what is assigned to you.

Generated from `tools/integration-codegen/specs/linear.mjs`. Edit the spec and run
`pnpm gen:integrations`; `src/` is overwritten, so hand edits there are lost.

## Credentials

Create a personal API key in Linear under Settings → Security & access → Personal API keys. See [the upstream docs](https://developers.linear.app/docs/graphql/working-with-the-graphql-api).

The credential is held by the auth scheme and applied per request. No action
handler, result, or code-mode script can read it, and `allowedHosts` keeps a
credentialed request from being redirected off `api.linear.app` by a URL that
arrived in a model's arguments.

## Usage

```ts
import { Computer } from "@cloudfarm/computer";
import { linear } from "@cloudfarm/linear";

const computer = new Computer({
  apps: [linear({ apiKey: process.env.LINEAR_API_KEY! })],
});
```

## Actions

| ref                         | what it does                                                                | effects     |
| --------------------------- | --------------------------------------------------------------------------- | ----------- |
| `linear.listTeams`          | List the teams this key can see, with the ids other actions need.           | read        |
| `linear.createIssue`        | Open an issue on a team's board.                                            | write       |
| `linear.searchIssues`       | Search issues by text across the workspace.                                 | read        |
| `linear.commentOnIssue`     | Add a comment to an issue.                                                  | write       |
| `linear.myIssues`           | Read the issues assigned to the key's own user.                             | read        |
| `linear.listIssues`         | List issues, filtered by team, state category or assignee.                  | read        |
| `linear.getIssue`           | Read one issue in full, with its description and labels.                    | read        |
| `linear.updateIssue`        | Change an issue: its state, assignee, title, priority, estimate or project. | write       |
| `linear.listWorkflowStates` | List a team's workflow states, with the ids an issue move needs.            | read        |
| `linear.listUsers`          | List workspace members, with the ids assignment needs.                      | read        |
| `linear.listProjects`       | List projects, with their progress and target dates.                        | read        |
| `linear.getProject`         | Read one project, with its progress and lead.                               | read        |
| `linear.createProject`      | Create a project for one or more teams.                                     | write       |
| `linear.listIssueComments`  | Read the comments on an issue.                                              | read        |
| `linear.listLabels`         | List issue labels, with the ids labelling needs.                            | read        |
| `linear.addLabelToIssue`    | Add a label to an issue.                                                    | write       |
| `linear.linkUrlToIssue`     | Attach a URL to an issue, e.g. the pull request that fixes it.              | write       |
| `linear.archiveIssue`       | Archive an issue, taking it off the board.                                  | destructive |
| `linear.listCycles`         | List cycles (sprints), with their dates and progress.                       | read        |
| `linear.me`                 | Read the user the API key belongs to.                                       | read        |

Every action goes through `context.http`, so a non-2xx arrives as an `HttpError`
carrying its status: a 429 reaches the model as a retryable rate limit rather
than a permanent fault. Runs on Node **and** Workers — it uses nothing but
`fetch`.
