---
title: GitHub
description: Code hosting. Read and open issues, comment on them, list pull requests and commits, and search issues across GitHub.
app:
  package: "@cloudfarm/github"
  icon: "https://cdn.simpleicons.org/github"
  credential: api-key
  mark: Gi
---

## Install

```bash
pnpm add @cloudfarm/github
```

## Connect

```ts
import { github } from "@cloudfarm/github";

const computer = new Computer({
  apps: [
    github({
      apiKey: process.env.GITHUB_API_KEY,
    }),
  ],
});
```

Create a fine-grained personal access token at github.com/settings/tokens with read access to the repositories you want, plus write access to issues if an agent should open them.

| Option   | Type     | Notes                                                             |
| -------- | -------- | ----------------------------------------------------------------- |
| `apiKey` | `string` | Required. A GitHub personal access token (github_pat_… or ghp_…). |

Requests may only reach `api.github.com`.

## What the agent can do

| Action                        | Does                                                                | Writes |
| ----------------------------- | ------------------------------------------------------------------- | ------ |
| `github.listIssues`           | List issues on a repository, newest first                           | no     |
| `github.createIssue`          | Open an issue on a repository                                       | yes    |
| `github.commentOnIssue`       | Comment on an issue or pull request                                 | yes    |
| `github.listPullRequests`     | List pull requests on a repository                                  | no     |
| `github.listCommits`          | List recent commits on a repository or branch                       | no     |
| `github.searchIssues`         | Search issues and pull requests across GitHub with its query syntax | no     |
| `github.getIssue`             | Read one issue, with its body and current state                     | no     |
| `github.updateIssue`          | Edit an issue, or close and reopen one                              | yes    |
| `github.listIssueComments`    | Read the comments on an issue or pull request                       | no     |
| `github.createPullRequest`    | Open a pull request from one branch into another                    | yes    |
| `github.getPullRequest`       | Read a pull request, with its branches and diff size                | no     |
| `github.listPullRequestFiles` | List the files a pull request touches, with per-file line counts    | no     |
| `github.mergePullRequest`     | Merge a pull request                                                | yes    |
| `github.reviewPullRequest`    | Approve a pull request, request changes, or leave a review comment  | yes    |
| `github.getFile`              | Read a file from a repository as text                               | no     |
| `github.writeFile`            | Create or overwrite a file, as one commit                           | yes    |
| `github.listBranches`         | List a repository's branches                                        | no     |
| `github.getBranch`            | Read one branch, with the commit sha at its tip                     | no     |
| `github.createBranch`         | Create a branch at a commit                                         | yes    |
| `github.listReleases`         | List a repository's releases, newest first                          | no     |
| `github.createRelease`        | Cut a release from a tag                                            | yes    |
| `github.getRepo`              | Read a repository's description, default branch and counts          | no     |
| `github.listMyRepos`          | List repositories the token can reach, most recently updated first  | no     |
| `github.searchCode`           | Search code across GitHub with its code-search syntax               | no     |
| `github.searchRepositories`   | Search repositories across GitHub                                   | no     |
| `github.listWorkflowRuns`     | List GitHub Actions runs, newest first                              | no     |
| `github.getWorkflowRun`       | Read one Actions run, with its conclusion and commit                | no     |
| `github.compareCommits`       | Compare two branches, tags or commits                               | no     |
| `github.whoAmI`               | Read the account the token belongs to                               | no     |

```ts
run({ ref: "github.listIssues", args: { repo: "…" } });
run({ ref: "github.createIssue", args: { repo: "…", title: "…" } });
```

## Notes

Every repository-scoped action takes `repo` as `owner/name`, the form a
person pastes, and interpolates it into the path unencoded — it is itself
two path segments. Everything else a model can set is percent-encoded, so
an argument cannot climb the URL.

A personal access token is used rather than OAuth: the token is a string a
developer already has, and core's OAuth flow is not implemented.

Upstream API docs: <https://docs.github.com/en/rest>
