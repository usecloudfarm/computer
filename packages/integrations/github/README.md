# @cloudfarm/github

Code hosting. Read and open issues, comment on them, list pull requests and commits, and search issues across GitHub.

Generated from `tools/integration-codegen/specs/github.mjs`. Edit the spec and run
`pnpm gen:integrations`; `src/` is overwritten, so hand edits there are lost.

## Credentials

Create a fine-grained personal access token at github.com/settings/tokens with read access to the repositories you want, plus write access to issues if an agent should open them. See [the upstream docs](https://docs.github.com/en/rest).

The credential is held by the auth scheme and applied per request. No action
handler, result, or code-mode script can read it, and `allowedHosts` keeps a
credentialed request from being redirected off `api.github.com` by a URL that
arrived in a model's arguments.

## Usage

```ts
import { Computer } from "@cloudfarm/computer";
import { github } from "@cloudfarm/github";

const computer = new Computer({
  apps: [github({ apiKey: process.env.GITHUB_API_KEY! })],
});
```

## Actions

| ref                           | what it does                                                         | effects     |
| ----------------------------- | -------------------------------------------------------------------- | ----------- |
| `github.listIssues`           | List issues on a repository, newest first.                           | read        |
| `github.createIssue`          | Open an issue on a repository.                                       | write       |
| `github.commentOnIssue`       | Comment on an issue or pull request.                                 | write       |
| `github.listPullRequests`     | List pull requests on a repository.                                  | read        |
| `github.listCommits`          | List recent commits on a repository or branch.                       | read        |
| `github.searchIssues`         | Search issues and pull requests across GitHub with its query syntax. | read        |
| `github.getIssue`             | Read one issue, with its body and current state.                     | read        |
| `github.updateIssue`          | Edit an issue, or close and reopen one.                              | write       |
| `github.listIssueComments`    | Read the comments on an issue or pull request.                       | read        |
| `github.createPullRequest`    | Open a pull request from one branch into another.                    | write       |
| `github.getPullRequest`       | Read a pull request, with its branches and diff size.                | read        |
| `github.listPullRequestFiles` | List the files a pull request touches, with per-file line counts.    | read        |
| `github.mergePullRequest`     | Merge a pull request.                                                | destructive |
| `github.reviewPullRequest`    | Approve a pull request, request changes, or leave a review comment.  | write       |
| `github.getFile`              | Read a file from a repository as text.                               | read        |
| `github.writeFile`            | Create or overwrite a file, as one commit.                           | write       |
| `github.listBranches`         | List a repository's branches.                                        | read        |
| `github.getBranch`            | Read one branch, with the commit sha at its tip.                     | read        |
| `github.createBranch`         | Create a branch at a commit.                                         | write       |
| `github.listReleases`         | List a repository's releases, newest first.                          | read        |
| `github.createRelease`        | Cut a release from a tag.                                            | write       |
| `github.getRepo`              | Read a repository's description, default branch and counts.          | read        |
| `github.listMyRepos`          | List repositories the token can reach, most recently updated first.  | read        |
| `github.searchCode`           | Search code across GitHub with its code-search syntax.               | read        |
| `github.searchRepositories`   | Search repositories across GitHub.                                   | read        |
| `github.listWorkflowRuns`     | List GitHub Actions runs, newest first.                              | read        |
| `github.getWorkflowRun`       | Read one Actions run, with its conclusion and commit.                | read        |
| `github.compareCommits`       | Compare two branches, tags or commits.                               | read        |
| `github.whoAmI`               | Read the account the token belongs to.                               | read        |

Every action goes through `context.http`, so a non-2xx arrives as an `HttpError`
carrying its status: a 429 reaches the model as a retryable rate limit rather
than a permanent fault. Runs on Node **and** Workers — it uses nothing but
`fetch`.
