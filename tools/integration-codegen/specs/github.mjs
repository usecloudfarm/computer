/** GitHub: issues, pull requests, commits and code search over the REST API. */
export default {
  id: "github",
  name: "GitHub",
  description:
    "Code hosting. Read and open issues, comment on them, list pull requests and commits, and search issues across GitHub.",
  npmDescription: "GitHub as a Computer app: issues, pull requests, commits and search",
  icon: "https://cdn.simpleicons.org/github",
  docsUrl: "https://docs.github.com/en/rest",
  credentials:
    "Create a fine-grained personal access token at github.com/settings/tokens with read access to the repositories you want, plus write access to issues if an agent should open them.",
  auth: {
    kind: "apiKey",
    describe: "A GitHub personal access token (github_pat_… or ghp_…).",
  },
  baseUrl: "https://api.github.com",
  allowedHosts: ["api.github.com"],
  headers: {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  },
  notes: [
    "Every repository-scoped action takes `repo` as `owner/name`, the form a",
    "person pastes, and interpolates it into the path unencoded — it is itself",
    "two path segments. Everything else a model can set is percent-encoded, so",
    "an argument cannot climb the URL.",
    "",
    "A personal access token is used rather than OAuth: the token is a string a",
    "developer already has, and core's OAuth flow is not implemented.",
  ],
  actions: [
    {
      name: "listIssues",
      summary: "List issues on a repository, newest first.",
      useCases: [
        "list issues",
        "what issues are open",
        "show me the bug backlog",
        "what needs triaging",
      ],
      keywords: ["bug", "ticket", "backlog"],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        state: { type: "enum", values: ["open", "closed", "all"], default: "open", optional: true },
        labels: { type: "string", optional: true, describe: "Comma-separated label names." },
        limit: { type: "int", min: 1, max: 100, default: 30, optional: true },
      },
      request: {
        method: "GET",
        path: "repos/{repo*}/issues",
        query: { state: "$state", labels: "$labels", per_page: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          issues: {
            type: "array",
            // The response is a bare JSON array, so the list is the body itself.
            from: "",
            item: {
              type: "object",
              fields: {
                number: { type: "number" },
                title: { type: "string" },
                state: { type: "string" },
                url: { type: "string", from: "html_url" },
                author: { type: "string", from: "user.login" },
                comments: { type: "number" },
                createdAt: { type: "string", from: "created_at" },
              },
            },
          },
        },
      },
      args: { repo: "acme/web" },
      sample: [
        {
          number: 42,
          title: "Login fails on Safari",
          state: "open",
          html_url: "https://github.com/acme/web/issues/42",
          user: { login: "ada" },
          comments: 3,
          created_at: "2026-11-01T10:00:00Z",
        },
      ],
      expect: {
        issues: [
          {
            number: 42,
            title: "Login fails on Safari",
            state: "open",
            url: "https://github.com/acme/web/issues/42",
            author: "ada",
            comments: 3,
            createdAt: "2026-11-01T10:00:00Z",
          },
        ],
      },
    },

    {
      name: "createIssue",
      summary: "Open an issue on a repository.",
      useCases: ["create an issue", "file a bug on github", "open a ticket", "report a problem"],
      sideEffects: "write",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        title: { type: "string", min: 1 },
        body: { type: "string", optional: true, describe: "Markdown body." },
        labels: { type: "string[]", optional: true },
      },
      request: {
        method: "POST",
        path: "repos/{repo*}/issues",
        body: { title: "$title", body: "$body", labels: "$labels" },
      },
      output: {
        type: "object",
        fields: {
          number: { type: "number" },
          title: { type: "string" },
          url: { type: "string", from: "html_url" },
        },
      },
      args: { repo: "acme/web", title: "Login fails on Safari" },
      sample: {
        number: 42,
        title: "Login fails on Safari",
        html_url: "https://github.com/acme/web/issues/42",
      },
      expect: {
        number: 42,
        title: "Login fails on Safari",
        url: "https://github.com/acme/web/issues/42",
      },
    },

    {
      name: "commentOnIssue",
      summary: "Comment on an issue or pull request.",
      useCases: [
        "comment on an issue",
        "reply on a pull request",
        "leave a note on a github issue",
      ],
      sideEffects: "write",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        number: { type: "int", min: 1, describe: "Issue or pull request number." },
        body: { type: "string", min: 1 },
      },
      request: {
        method: "POST",
        path: "repos/{repo*}/issues/{number}/comments",
        body: { body: "$body" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "number" },
          url: { type: "string", from: "html_url" },
        },
      },
      args: { repo: "acme/web", number: 42, body: "Reproduced on 17.4." },
      sample: {
        id: 900,
        html_url: "https://github.com/acme/web/issues/42#issuecomment-900",
      },
      expect: { id: 900, url: "https://github.com/acme/web/issues/42#issuecomment-900" },
    },

    {
      name: "listPullRequests",
      summary: "List pull requests on a repository.",
      useCases: [
        "list pull requests",
        "what prs are open",
        "what is waiting for review",
        "show me recent prs",
      ],
      keywords: ["pr", "review", "merge"],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        state: { type: "enum", values: ["open", "closed", "all"], default: "open", optional: true },
        limit: { type: "int", min: 1, max: 100, default: 30, optional: true },
      },
      request: {
        method: "GET",
        path: "repos/{repo*}/pulls",
        query: { state: "$state", per_page: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          pullRequests: {
            type: "array",
            // The response is a bare JSON array, so the list is the body itself.
            from: "",
            item: {
              type: "object",
              fields: {
                number: { type: "number" },
                title: { type: "string" },
                state: { type: "string" },
                draft: { type: "boolean" },
                url: { type: "string", from: "html_url" },
                author: { type: "string", from: "user.login" },
                branch: { type: "string", from: "head.ref" },
              },
            },
          },
        },
      },
      args: { repo: "acme/web" },
      sample: [
        {
          number: 51,
          title: "Fix Safari login",
          state: "open",
          draft: false,
          html_url: "https://github.com/acme/web/pull/51",
          user: { login: "ada" },
          head: { ref: "fix/safari-login" },
        },
      ],
      expect: {
        pullRequests: [
          {
            number: 51,
            title: "Fix Safari login",
            state: "open",
            draft: false,
            url: "https://github.com/acme/web/pull/51",
            author: "ada",
            branch: "fix/safari-login",
          },
        ],
      },
    },

    {
      name: "listCommits",
      summary: "List recent commits on a repository or branch.",
      useCases: [
        "what shipped",
        "list recent commits",
        "what changed this week",
        "show the commit log",
      ],
      keywords: ["changelog", "history", "log"],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        branch: { type: "string", optional: true, describe: "Defaults to the default branch." },
        since: { type: "string", optional: true, describe: "ISO 8601 timestamp." },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "repos/{repo*}/commits",
        query: { sha: "$branch", since: "$since", per_page: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          commits: {
            type: "array",
            // The response is a bare JSON array, so the list is the body itself.
            from: "",
            item: {
              type: "object",
              fields: {
                sha: { type: "string" },
                message: { type: "string", from: "commit.message" },
                author: { type: "string", from: "commit.author.name" },
                date: { type: "string", from: "commit.author.date" },
                url: { type: "string", from: "html_url" },
              },
            },
          },
        },
      },
      args: { repo: "acme/web" },
      sample: [
        {
          sha: "abc1234",
          commit: {
            message: "fix(auth): accept Safari cookies",
            author: { name: "Ada", date: "2026-11-20T09:00:00Z" },
          },
          html_url: "https://github.com/acme/web/commit/abc1234",
        },
      ],
      expect: {
        commits: [
          {
            sha: "abc1234",
            message: "fix(auth): accept Safari cookies",
            author: "Ada",
            date: "2026-11-20T09:00:00Z",
            url: "https://github.com/acme/web/commit/abc1234",
          },
        ],
      },
    },

    {
      name: "searchIssues",
      summary: "Search issues and pull requests across GitHub with its query syntax.",
      useCases: [
        "search github issues",
        "find an issue about",
        "has anyone reported",
        "search prs mentioning",
      ],
      sideEffects: "read",
      input: {
        query: {
          type: "string",
          min: 1,
          describe: 'GitHub search syntax, e.g. "repo:acme/web is:open label:bug".',
        },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "search/issues",
        query: { q: "$query", per_page: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          total: { type: "number", from: "total_count" },
          issues: {
            type: "array",
            from: "items",
            item: {
              type: "object",
              fields: {
                number: { type: "number" },
                title: { type: "string" },
                state: { type: "string" },
                url: { type: "string", from: "html_url" },
                repository: { type: "string", from: "repository_url" },
              },
            },
          },
        },
      },
      args: { query: "repo:acme/web is:open label:bug" },
      sample: {
        total_count: 1,
        items: [
          {
            number: 42,
            title: "Login fails on Safari",
            state: "open",
            html_url: "https://github.com/acme/web/issues/42",
            repository_url: "https://api.github.com/repos/acme/web",
          },
        ],
      },
      expect: {
        total: 1,
        issues: [
          {
            number: 42,
            title: "Login fails on Safari",
            state: "open",
            url: "https://github.com/acme/web/issues/42",
            repository: "https://api.github.com/repos/acme/web",
          },
        ],
      },
    },
    {
      name: "getIssue",
      summary: "Read one issue, with its body and current state.",
      useCases: ["read an issue", "what does issue 42 say", "open a github issue by number"],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        number: { type: "int", min: 1 },
      },
      request: { method: "GET", path: "repos/{repo*}/issues/{number}" },
      output: {
        type: "object",
        fields: {
          number: { type: "number" },
          title: { type: "string" },
          state: { type: "string" },
          body: { type: "string", optional: true },
          author: { type: "string", from: "user.login" },
          comments: { type: "number" },
          url: { type: "string", from: "html_url" },
        },
      },
      args: { repo: "acme/web", number: 42 },
      sample: {
        number: 42,
        title: "Login fails on Safari",
        state: "open",
        body: "Steps to reproduce…",
        user: { login: "ada" },
        comments: 3,
        html_url: "https://github.com/acme/web/issues/42",
      },
      expect: {
        number: 42,
        title: "Login fails on Safari",
        state: "open",
        body: "Steps to reproduce…",
        author: "ada",
        comments: 3,
        url: "https://github.com/acme/web/issues/42",
      },
    },

    {
      name: "updateIssue",
      summary: "Edit an issue, or close and reopen one.",
      useCases: [
        "close an issue",
        "reopen an issue",
        "retitle an issue",
        "relabel an issue",
        "assign an issue",
        "mark an issue as done",
      ],
      keywords: ["close", "triage", "assign"],
      sideEffects: "write",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        number: { type: "int", min: 1 },
        title: { type: "string", optional: true },
        body: { type: "string", optional: true },
        state: { type: "enum", values: ["open", "closed"], optional: true },
        stateReason: {
          type: "enum",
          values: ["completed", "not_planned", "reopened"],
          optional: true,
          describe: "Why it closed; GitHub shows it on the timeline.",
        },
        labels: { type: "string[]", optional: true, describe: "Replaces the current labels." },
        assignees: {
          type: "string[]",
          optional: true,
          describe: "Replaces the current assignees.",
        },
      },
      request: {
        method: "PATCH",
        path: "repos/{repo*}/issues/{number}",
        body: {
          title: "$title",
          body: "$body",
          state: "$state",
          state_reason: "$stateReason",
          labels: "$labels",
          assignees: "$assignees",
        },
      },
      output: {
        type: "object",
        fields: {
          number: { type: "number" },
          title: { type: "string" },
          state: { type: "string" },
          url: { type: "string", from: "html_url" },
        },
      },
      args: { repo: "acme/web", number: 42, state: "closed", stateReason: "completed" },
      sample: {
        number: 42,
        title: "Login fails on Safari",
        state: "closed",
        html_url: "https://github.com/acme/web/issues/42",
      },
      expect: {
        number: 42,
        title: "Login fails on Safari",
        state: "closed",
        url: "https://github.com/acme/web/issues/42",
      },
    },

    {
      name: "listIssueComments",
      summary: "Read the comments on an issue or pull request.",
      useCases: [
        "read the comments on an issue",
        "what was said on this pr",
        "catch up on a github thread",
      ],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        number: { type: "int", min: 1 },
        limit: { type: "int", min: 1, max: 100, default: 30, optional: true },
      },
      request: {
        method: "GET",
        path: "repos/{repo*}/issues/{number}/comments",
        query: { per_page: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          comments: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "number" },
                author: { type: "string", from: "user.login" },
                body: { type: "string" },
                createdAt: { type: "string", from: "created_at" },
                url: { type: "string", from: "html_url" },
              },
            },
          },
        },
      },
      args: { repo: "acme/web", number: 42 },
      sample: [
        {
          id: 900,
          user: { login: "ada" },
          body: "Reproduced on 17.4.",
          created_at: "2026-11-21T10:00:00Z",
          html_url: "https://github.com/acme/web/issues/42#issuecomment-900",
        },
      ],
      expect: {
        comments: [
          {
            id: 900,
            author: "ada",
            body: "Reproduced on 17.4.",
            createdAt: "2026-11-21T10:00:00Z",
            url: "https://github.com/acme/web/issues/42#issuecomment-900",
          },
        ],
      },
    },

    {
      name: "createPullRequest",
      summary: "Open a pull request from one branch into another.",
      useCases: [
        "open a pull request",
        "create a pr",
        "raise a pr for this branch",
        "submit changes for review",
      ],
      keywords: ["pr", "merge", "review"],
      sideEffects: "write",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        title: { type: "string", min: 1 },
        head: { type: "string", describe: "Branch the changes are on." },
        base: { type: "string", describe: "Branch to merge into, e.g. main." },
        body: { type: "string", optional: true, describe: "Markdown description." },
        draft: { type: "boolean", optional: true },
      },
      request: {
        method: "POST",
        path: "repos/{repo*}/pulls",
        body: { title: "$title", head: "$head", base: "$base", body: "$body", draft: "$draft" },
      },
      output: {
        type: "object",
        fields: {
          number: { type: "number" },
          state: { type: "string" },
          draft: { type: "boolean" },
          url: { type: "string", from: "html_url" },
        },
      },
      args: {
        repo: "acme/web",
        title: "Fix Safari login",
        head: "fix/safari-login",
        base: "main",
      },
      sample: {
        number: 51,
        state: "open",
        draft: false,
        html_url: "https://github.com/acme/web/pull/51",
      },
      expect: {
        number: 51,
        state: "open",
        draft: false,
        url: "https://github.com/acme/web/pull/51",
      },
    },

    {
      name: "getPullRequest",
      summary: "Read a pull request, with its branches and diff size.",
      useCases: [
        "read a pull request",
        "is this pr mergeable",
        "how big is this pr",
        "what branch does this pr target",
      ],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        number: { type: "int", min: 1 },
      },
      request: { method: "GET", path: "repos/{repo*}/pulls/{number}" },
      output: {
        type: "object",
        fields: {
          number: { type: "number" },
          title: { type: "string" },
          state: { type: "string" },
          draft: { type: "boolean" },
          merged: { type: "boolean" },
          mergeable: {
            type: "boolean",
            optional: true,
            describe: "Absent while GitHub computes it.",
          },
          additions: { type: "number" },
          deletions: { type: "number" },
          changedFiles: { type: "number", from: "changed_files" },
          head: { type: "string", from: "head.ref" },
          base: { type: "string", from: "base.ref" },
          author: { type: "string", from: "user.login" },
          url: { type: "string", from: "html_url" },
        },
      },
      args: { repo: "acme/web", number: 51 },
      sample: {
        number: 51,
        title: "Fix Safari login",
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        additions: 12,
        deletions: 3,
        changed_files: 2,
        head: { ref: "fix/safari-login" },
        base: { ref: "main" },
        user: { login: "ada" },
        html_url: "https://github.com/acme/web/pull/51",
      },
      expect: {
        number: 51,
        title: "Fix Safari login",
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        head: "fix/safari-login",
        base: "main",
        author: "ada",
        url: "https://github.com/acme/web/pull/51",
      },
    },

    {
      name: "listPullRequestFiles",
      summary: "List the files a pull request touches, with per-file line counts.",
      useCases: [
        "what files does this pr change",
        "review the diff",
        "how big is each file change",
      ],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        number: { type: "int", min: 1 },
        limit: { type: "int", min: 1, max: 100, default: 50, optional: true },
      },
      request: {
        method: "GET",
        path: "repos/{repo*}/pulls/{number}/files",
        query: { per_page: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          files: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                filename: { type: "string" },
                status: { type: "string" },
                additions: { type: "number" },
                deletions: { type: "number" },
                changes: { type: "number" },
              },
            },
          },
        },
      },
      args: { repo: "acme/web", number: 51 },
      sample: [
        { filename: "src/auth.ts", status: "modified", additions: 10, deletions: 2, changes: 12 },
      ],
      expect: {
        files: [
          { filename: "src/auth.ts", status: "modified", additions: 10, deletions: 2, changes: 12 },
        ],
      },
    },

    {
      name: "mergePullRequest",
      summary: "Merge a pull request.",
      useCases: ["merge a pull request", "merge this pr", "squash and merge", "land the pr"],
      sideEffects: "destructive",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        number: { type: "int", min: 1 },
        mergeMethod: {
          type: "enum",
          values: ["merge", "squash", "rebase"],
          default: "squash",
          optional: true,
        },
        commitTitle: { type: "string", optional: true },
      },
      request: {
        method: "PUT",
        path: "repos/{repo*}/pulls/{number}/merge",
        body: { merge_method: "$mergeMethod", commit_title: "$commitTitle" },
      },
      output: {
        type: "object",
        fields: {
          merged: { type: "boolean" },
          sha: { type: "string" },
          message: { type: "string" },
        },
      },
      args: { repo: "acme/web", number: 51 },
      sample: { merged: true, sha: "def5678", message: "Pull Request successfully merged" },
      expect: { merged: true, sha: "def5678", message: "Pull Request successfully merged" },
    },

    {
      name: "reviewPullRequest",
      summary: "Approve a pull request, request changes, or leave a review comment.",
      useCases: [
        "approve a pr",
        "request changes on a pr",
        "review a pull request",
        "sign off on a pr",
      ],
      sideEffects: "write",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        number: { type: "int", min: 1 },
        event: {
          type: "enum",
          values: ["APPROVE", "REQUEST_CHANGES", "COMMENT"],
          describe: "REQUEST_CHANGES and COMMENT require a body.",
        },
        body: { type: "string", optional: true },
      },
      request: {
        method: "POST",
        path: "repos/{repo*}/pulls/{number}/reviews",
        body: { event: "$event", body: "$body" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "number" },
          state: { type: "string" },
          url: { type: "string", from: "html_url" },
        },
      },
      args: { repo: "acme/web", number: 51, event: "APPROVE" },
      sample: {
        id: 7001,
        state: "APPROVED",
        html_url: "https://github.com/acme/web/pull/51#pullrequestreview-7001",
      },
      expect: {
        id: 7001,
        state: "APPROVED",
        url: "https://github.com/acme/web/pull/51#pullrequestreview-7001",
      },
    },

    {
      name: "getFile",
      summary: "Read a file from a repository as text.",
      useCases: [
        "read a file from github",
        "show me the readme",
        "what is in this config file",
        "open a source file",
      ],
      keywords: ["contents", "source", "blob"],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        path: { type: "string", describe: "Path inside the repository, e.g. src/auth.ts." },
        ref: {
          type: "string",
          optional: true,
          describe: "Branch, tag or commit; defaults to the default branch.",
        },
      },
      // GitHub returns the file base64-encoded, which no declarative mapping can
      // undo — this is what the raw-handler escape hatch is for.
      handler: `async ({ repo, path, ref }, context) => {
  const file = await context.http.get(\`repos/\${repo}/contents/\${path}\`, { query: { ref } });
  const encoded = String(file["content"] ?? "").replace(/\\s/g, "");
  const text =
    file["encoding"] === "base64"
      ? new TextDecoder().decode(
          Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
        )
      : encoded;
  return {
    path: String(file["path"] ?? ""),
    sha: String(file["sha"] ?? ""),
    size: Number(file["size"] ?? 0),
    text,
    url: String(file["html_url"] ?? ""),
  };
}`,
      output: {
        type: "object",
        fields: {
          path: { type: "string" },
          sha: { type: "string", describe: "Blob sha; github.writeFile needs it to overwrite." },
          size: { type: "number" },
          text: { type: "string" },
          url: { type: "string" },
        },
      },
      args: { repo: "acme/web", path: "README.md" },
      sample: {
        path: "README.md",
        sha: "aaa111",
        size: 11,
        content: "aGVsbG8gd29ybGQ=",
        encoding: "base64",
        html_url: "https://github.com/acme/web/blob/main/README.md",
      },
      expect: {
        path: "README.md",
        sha: "aaa111",
        size: 11,
        text: "hello world",
        url: "https://github.com/acme/web/blob/main/README.md",
      },
    },

    {
      name: "writeFile",
      summary: "Create or overwrite a file, as one commit.",
      useCases: [
        "commit a file to github",
        "write a file to a repo",
        "update a file on a branch",
        "add a file and commit it",
      ],
      sideEffects: "write",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        path: { type: "string", describe: "Path inside the repository." },
        text: { type: "string", describe: "New file contents." },
        message: { type: "string", describe: "Commit message." },
        branch: { type: "string", optional: true, describe: "Defaults to the default branch." },
        sha: {
          type: "string",
          optional: true,
          describe: "Blob sha of the file being replaced, from github.getFile. Omit to create.",
        },
      },
      handler: `async ({ repo, path, text, message, branch, sha }, context) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const written = await context.http.put(\`repos/\${repo}/contents/\${path}\`, {
    message,
    content: btoa(binary),
    branch,
    sha,
  });
  return {
    path: String((written["content"] as Record<string, unknown> | undefined)?.["path"] ?? path),
    sha: String((written["content"] as Record<string, unknown> | undefined)?.["sha"] ?? ""),
    commit: String((written["commit"] as Record<string, unknown> | undefined)?.["sha"] ?? ""),
  };
}`,
      output: {
        type: "object",
        fields: {
          path: { type: "string" },
          sha: { type: "string", describe: "New blob sha." },
          commit: { type: "string", describe: "Commit sha." },
        },
      },
      args: {
        repo: "acme/web",
        path: "docs/notes.md",
        text: "hello world",
        message: "docs: add notes",
      },
      sample: {
        content: { path: "docs/notes.md", sha: "bbb222" },
        commit: { sha: "ccc333" },
      },
      expect: { path: "docs/notes.md", sha: "bbb222", commit: "ccc333" },
    },

    {
      name: "listBranches",
      summary: "List a repository's branches.",
      useCases: ["list branches", "what branches exist", "find a branch name"],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        limit: { type: "int", min: 1, max: 100, default: 50, optional: true },
      },
      request: {
        method: "GET",
        path: "repos/{repo*}/branches",
        query: { per_page: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          branches: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                name: { type: "string" },
                sha: { type: "string", from: "commit.sha" },
                protected: { type: "boolean" },
              },
            },
          },
        },
      },
      args: { repo: "acme/web" },
      sample: [{ name: "main", commit: { sha: "abc1234" }, protected: true }],
      expect: { branches: [{ name: "main", sha: "abc1234", protected: true }] },
    },

    {
      name: "getBranch",
      summary: "Read one branch, with the commit sha at its tip.",
      useCases: ["what is the head of main", "get a branch sha", "read a branch"],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        branch: { type: "string" },
      },
      request: { method: "GET", path: "repos/{repo*}/branches/{branch*}" },
      output: {
        type: "object",
        fields: {
          name: { type: "string" },
          sha: {
            type: "string",
            from: "commit.sha",
            describe: "github.createBranch starts from this.",
          },
          protected: { type: "boolean" },
        },
      },
      args: { repo: "acme/web", branch: "main" },
      sample: { name: "main", commit: { sha: "abc1234" }, protected: true },
      expect: { name: "main", sha: "abc1234", protected: true },
    },

    {
      name: "createBranch",
      summary: "Create a branch at a commit.",
      useCases: ["create a branch", "branch off main", "start a new branch for this change"],
      sideEffects: "write",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        branch: { type: "string", describe: "New branch name, without refs/heads/." },
        sha: { type: "string", describe: "Commit to branch from, e.g. from github.getBranch." },
      },
      request: {
        method: "POST",
        path: "repos/{repo*}/git/refs",
        // GitHub wants the fully qualified ref; the agent passes a plain name.
        body: { ref: { raw: "`refs/heads/${branch}`", uses: ["branch"] }, sha: "$sha" },
      },
      output: {
        type: "object",
        fields: {
          ref: { type: "string" },
          sha: { type: "string", from: "object.sha" },
        },
      },
      args: { repo: "acme/web", branch: "fix/safari-login", sha: "abc1234" },
      sample: { ref: "refs/heads/fix/safari-login", object: { sha: "abc1234" } },
      expect: { ref: "refs/heads/fix/safari-login", sha: "abc1234" },
    },

    {
      name: "listReleases",
      summary: "List a repository's releases, newest first.",
      useCases: [
        "list releases",
        "what version shipped last",
        "show me the releases",
        "latest release",
      ],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "repos/{repo*}/releases",
        query: { per_page: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          releases: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "number" },
                tag: { type: "string", from: "tag_name" },
                name: { type: "string", optional: true },
                draft: { type: "boolean" },
                prerelease: { type: "boolean" },
                publishedAt: { type: "string", from: "published_at", optional: true },
                url: { type: "string", from: "html_url" },
              },
            },
          },
        },
      },
      args: { repo: "acme/web" },
      sample: [
        {
          id: 3001,
          tag_name: "v1.2.0",
          name: "v1.2.0",
          draft: false,
          prerelease: false,
          published_at: "2026-11-20T09:00:00Z",
          html_url: "https://github.com/acme/web/releases/tag/v1.2.0",
        },
      ],
      expect: {
        releases: [
          {
            id: 3001,
            tag: "v1.2.0",
            name: "v1.2.0",
            draft: false,
            prerelease: false,
            publishedAt: "2026-11-20T09:00:00Z",
            url: "https://github.com/acme/web/releases/tag/v1.2.0",
          },
        ],
      },
    },

    {
      name: "createRelease",
      summary: "Cut a release from a tag.",
      useCases: ["create a release", "cut a release", "publish release notes", "tag a version"],
      sideEffects: "write",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        tag: { type: "string", describe: "Tag name; created at the target if it does not exist." },
        name: { type: "string", optional: true },
        body: { type: "string", optional: true, describe: "Release notes, markdown." },
        draft: { type: "boolean", optional: true },
        prerelease: { type: "boolean", optional: true },
      },
      request: {
        method: "POST",
        path: "repos/{repo*}/releases",
        body: {
          tag_name: "$tag",
          name: "$name",
          body: "$body",
          draft: "$draft",
          prerelease: "$prerelease",
        },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "number" },
          tag: { type: "string", from: "tag_name" },
          draft: { type: "boolean" },
          url: { type: "string", from: "html_url" },
        },
      },
      args: { repo: "acme/web", tag: "v1.3.0", name: "v1.3.0" },
      sample: {
        id: 3002,
        tag_name: "v1.3.0",
        draft: false,
        html_url: "https://github.com/acme/web/releases/tag/v1.3.0",
      },
      expect: {
        id: 3002,
        tag: "v1.3.0",
        draft: false,
        url: "https://github.com/acme/web/releases/tag/v1.3.0",
      },
    },

    {
      name: "getRepo",
      summary: "Read a repository's description, default branch and counts.",
      useCases: [
        "what is this repo",
        "repo details",
        "what is the default branch",
        "how many stars",
      ],
      sideEffects: "read",
      input: { repo: { type: "string", describe: 'Repository as "owner/name".' } },
      request: { method: "GET", path: "repos/{repo*}" },
      output: {
        type: "object",
        fields: {
          fullName: { type: "string", from: "full_name" },
          description: { type: "string", optional: true },
          private: { type: "boolean" },
          defaultBranch: { type: "string", from: "default_branch" },
          language: { type: "string", optional: true },
          stars: { type: "number", from: "stargazers_count" },
          openIssues: { type: "number", from: "open_issues_count" },
          url: { type: "string", from: "html_url" },
        },
      },
      args: { repo: "acme/web" },
      sample: {
        full_name: "acme/web",
        description: "The web app",
        private: false,
        default_branch: "main",
        language: "TypeScript",
        stargazers_count: 128,
        open_issues_count: 7,
        html_url: "https://github.com/acme/web",
      },
      expect: {
        fullName: "acme/web",
        description: "The web app",
        private: false,
        defaultBranch: "main",
        language: "TypeScript",
        stars: 128,
        openIssues: 7,
        url: "https://github.com/acme/web",
      },
    },

    {
      name: "listMyRepos",
      summary: "List repositories the token can reach, most recently updated first.",
      useCases: ["what repos do i have", "list my repositories", "find a repo i can access"],
      sideEffects: "read",
      input: {
        limit: { type: "int", min: 1, max: 100, default: 30, optional: true },
        sort: {
          type: "enum",
          values: ["created", "updated", "pushed", "full_name"],
          default: "updated",
          optional: true,
        },
      },
      request: { method: "GET", path: "user/repos", query: { per_page: "$limit", sort: "$sort" } },
      output: {
        type: "object",
        fields: {
          repos: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                fullName: { type: "string", from: "full_name" },
                description: { type: "string", optional: true },
                private: { type: "boolean" },
                language: { type: "string", optional: true },
                url: { type: "string", from: "html_url" },
              },
            },
          },
        },
      },
      args: {},
      sample: [
        {
          full_name: "acme/web",
          description: "The web app",
          private: false,
          language: "TypeScript",
          html_url: "https://github.com/acme/web",
        },
      ],
      expect: {
        repos: [
          {
            fullName: "acme/web",
            description: "The web app",
            private: false,
            language: "TypeScript",
            url: "https://github.com/acme/web",
          },
        ],
      },
    },

    {
      name: "searchCode",
      summary: "Search code across GitHub with its code-search syntax.",
      useCases: [
        "search code on github",
        "where is this function defined",
        "find usages of a symbol",
        "search a repo for a string",
      ],
      sideEffects: "read",
      input: {
        query: {
          type: "string",
          min: 1,
          describe: 'Code search syntax, e.g. "createApp repo:acme/web language:ts".',
        },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: { method: "GET", path: "search/code", query: { q: "$query", per_page: "$limit" } },
      output: {
        type: "object",
        fields: {
          total: { type: "number", from: "total_count" },
          matches: {
            type: "array",
            from: "items",
            item: {
              type: "object",
              fields: {
                path: { type: "string" },
                repository: { type: "string", from: "repository.full_name" },
                url: { type: "string", from: "html_url" },
              },
            },
          },
        },
      },
      args: { query: "createApp repo:acme/web" },
      sample: {
        total_count: 1,
        items: [
          {
            path: "src/index.ts",
            repository: { full_name: "acme/web" },
            html_url: "https://github.com/acme/web/blob/main/src/index.ts",
          },
        ],
      },
      expect: {
        total: 1,
        matches: [
          {
            path: "src/index.ts",
            repository: "acme/web",
            url: "https://github.com/acme/web/blob/main/src/index.ts",
          },
        ],
      },
    },

    {
      name: "searchRepositories",
      summary: "Search repositories across GitHub.",
      useCases: ["search for a repo", "find repositories about", "what libraries exist for"],
      sideEffects: "read",
      input: {
        query: {
          type: "string",
          min: 1,
          describe: 'e.g. "agent framework language:python stars:>500".',
        },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "search/repositories",
        query: { q: "$query", per_page: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          total: { type: "number", from: "total_count" },
          repos: {
            type: "array",
            from: "items",
            item: {
              type: "object",
              fields: {
                fullName: { type: "string", from: "full_name" },
                description: { type: "string", optional: true },
                stars: { type: "number", from: "stargazers_count" },
                language: { type: "string", optional: true },
                url: { type: "string", from: "html_url" },
              },
            },
          },
        },
      },
      args: { query: "agent framework language:typescript" },
      sample: {
        total_count: 1,
        items: [
          {
            full_name: "acme/agent",
            description: "An agent framework",
            stargazers_count: 900,
            language: "TypeScript",
            html_url: "https://github.com/acme/agent",
          },
        ],
      },
      expect: {
        total: 1,
        repos: [
          {
            fullName: "acme/agent",
            description: "An agent framework",
            stars: 900,
            language: "TypeScript",
            url: "https://github.com/acme/agent",
          },
        ],
      },
    },

    {
      name: "listWorkflowRuns",
      summary: "List GitHub Actions runs, newest first.",
      useCases: [
        "is ci passing",
        "did the build fail",
        "list workflow runs",
        "what is the state of the pipeline",
      ],
      keywords: ["ci", "actions", "build", "pipeline"],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        branch: { type: "string", optional: true },
        status: {
          type: "enum",
          values: ["queued", "in_progress", "completed", "success", "failure"],
          optional: true,
        },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: {
        method: "GET",
        path: "repos/{repo*}/actions/runs",
        query: { branch: "$branch", status: "$status", per_page: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          total: { type: "number", from: "total_count" },
          runs: {
            type: "array",
            from: "workflow_runs",
            item: {
              type: "object",
              fields: {
                id: { type: "number" },
                name: { type: "string", optional: true },
                status: { type: "string" },
                conclusion: {
                  type: "string",
                  optional: true,
                  describe: "Absent until the run finishes.",
                },
                branch: { type: "string", from: "head_branch", optional: true },
                event: { type: "string" },
                createdAt: { type: "string", from: "created_at" },
                url: { type: "string", from: "html_url" },
              },
            },
          },
        },
      },
      args: { repo: "acme/web" },
      sample: {
        total_count: 1,
        workflow_runs: [
          {
            id: 55001,
            name: "CI",
            status: "completed",
            conclusion: "failure",
            head_branch: "main",
            event: "push",
            created_at: "2026-11-24T07:00:00Z",
            html_url: "https://github.com/acme/web/actions/runs/55001",
          },
        ],
      },
      expect: {
        total: 1,
        runs: [
          {
            id: 55001,
            name: "CI",
            status: "completed",
            conclusion: "failure",
            branch: "main",
            event: "push",
            createdAt: "2026-11-24T07:00:00Z",
            url: "https://github.com/acme/web/actions/runs/55001",
          },
        ],
      },
    },

    {
      name: "getWorkflowRun",
      summary: "Read one Actions run, with its conclusion and commit.",
      useCases: ["why did ci fail", "read a workflow run", "what commit did this build run on"],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        runId: { type: "int", min: 1 },
      },
      request: { method: "GET", path: "repos/{repo*}/actions/runs/{runId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "number" },
          name: { type: "string", optional: true },
          status: { type: "string" },
          conclusion: { type: "string", optional: true },
          branch: { type: "string", from: "head_branch", optional: true },
          sha: { type: "string", from: "head_sha" },
          event: { type: "string" },
          url: { type: "string", from: "html_url" },
        },
      },
      args: { repo: "acme/web", runId: 55001 },
      sample: {
        id: 55001,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        head_branch: "main",
        head_sha: "abc1234",
        event: "push",
        html_url: "https://github.com/acme/web/actions/runs/55001",
      },
      expect: {
        id: 55001,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        branch: "main",
        sha: "abc1234",
        event: "push",
        url: "https://github.com/acme/web/actions/runs/55001",
      },
    },

    {
      name: "compareCommits",
      summary: "Compare two branches, tags or commits.",
      useCases: [
        "what changed between these versions",
        "diff two branches",
        "what is in main that is not in this branch",
        "changes since the last release",
      ],
      keywords: ["diff", "changelog", "compare"],
      sideEffects: "read",
      input: {
        repo: { type: "string", describe: 'Repository as "owner/name".' },
        basehead: {
          type: "string",
          describe: 'Base and head separated by three dots, e.g. "v1.2.0...main".',
        },
      },
      request: { method: "GET", path: "repos/{repo*}/compare/{basehead*}" },
      output: {
        type: "object",
        fields: {
          status: { type: "string", describe: "ahead, behind, identical or diverged." },
          aheadBy: { type: "number", from: "ahead_by" },
          behindBy: { type: "number", from: "behind_by" },
          totalCommits: { type: "number", from: "total_commits" },
          url: { type: "string", from: "html_url" },
          commits: {
            type: "array",
            item: {
              type: "object",
              fields: {
                sha: { type: "string" },
                message: { type: "string", from: "commit.message" },
                author: { type: "string", from: "commit.author.name" },
              },
            },
          },
        },
      },
      args: { repo: "acme/web", basehead: "v1.2.0...main" },
      sample: {
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        html_url: "https://github.com/acme/web/compare/v1.2.0...main",
        commits: [
          {
            sha: "abc1234",
            commit: { message: "fix(auth): accept Safari cookies", author: { name: "Ada" } },
          },
        ],
      },
      expect: {
        status: "ahead",
        aheadBy: 1,
        behindBy: 0,
        totalCommits: 1,
        url: "https://github.com/acme/web/compare/v1.2.0...main",
        commits: [{ sha: "abc1234", message: "fix(auth): accept Safari cookies", author: "Ada" }],
      },
    },

    {
      name: "whoAmI",
      summary: "Read the account the token belongs to.",
      useCases: ["who am i on github", "what account is this token", "my github login"],
      sideEffects: "read",
      input: {},
      request: { method: "GET", path: "user" },
      output: {
        type: "object",
        fields: {
          login: { type: "string" },
          name: { type: "string", optional: true },
          url: { type: "string", from: "html_url" },
        },
      },
      args: {},
      sample: { login: "ada", name: "Ada Lovelace", html_url: "https://github.com/ada" },
      expect: { login: "ada", name: "Ada Lovelace", url: "https://github.com/ada" },
    },
  ],
};
