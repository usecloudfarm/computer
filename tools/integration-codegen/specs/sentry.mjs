/** Sentry: triage errors from the issue, event and release APIs. */

/** The issue fields worth handing a model, shared by the two issue lists. */
const issueItem = {
  type: "object",
  fields: {
    id: { type: "string" },
    shortId: { type: "string" },
    title: { type: "string" },
    culprit: { type: "string", optional: true },
    level: { type: "string" },
    status: { type: "string" },
    substatus: { type: "string", optional: true },
    priority: { type: "string", optional: true },
    count: { type: "number", describe: "Events in the stats period." },
    userCount: { type: "number" },
    assignedTo: { type: "string", from: "assignedTo.name", optional: true },
    firstSeen: { type: "string", optional: true },
    lastSeen: { type: "string" },
    permalink: { type: "string" },
  },
};

const sampleIssue = {
  id: "1001",
  shortId: "WEB-7",
  title: "TypeError: undefined is not a function",
  culprit: "app/login",
  level: "error",
  status: "unresolved",
  substatus: "ongoing",
  priority: "high",
  count: "137",
  userCount: 42,
  assignedTo: { name: "Ada Lovelace" },
  firstSeen: "2026-11-18T12:00:00Z",
  lastSeen: "2026-11-24T08:00:00Z",
  permalink: "https://acme.sentry.io/issues/1001/",
};

const expectedIssue = {
  id: "1001",
  shortId: "WEB-7",
  title: "TypeError: undefined is not a function",
  culprit: "app/login",
  level: "error",
  status: "unresolved",
  substatus: "ongoing",
  priority: "high",
  count: 137,
  userCount: 42,
  assignedTo: "Ada Lovelace",
  firstSeen: "2026-11-18T12:00:00Z",
  lastSeen: "2026-11-24T08:00:00Z",
  permalink: "https://acme.sentry.io/issues/1001/",
};

export default {
  id: "sentry",
  name: "Sentry",
  description:
    "Error tracking. List, read and triage issues, inspect the events behind one, assign and resolve them, and read releases, projects and teams.",
  npmDescription: "Sentry as a Computer app: read, triage and resolve issues",
  docsUrl: "https://docs.sentry.io/api/",
  credentials:
    "Create an organization auth token in Sentry under Settings → Auth Tokens with the `project:read`, `event:read` and (for triage) `event:write` scopes.",
  auth: { kind: "apiKey", describe: "A Sentry auth token (sntrys_… or a user token)." },
  baseUrl: "https://sentry.io/api/0",
  allowedHosts: ["sentry.io"],
  notes: [
    "Sentry's paths carry trailing slashes and it is strict about them, so the",
    "spec writes them literally rather than trusting a normaliser.",
    "",
    "Every issue path is organization-scoped — `organizations/{org}/issues/…`,",
    "not the older bare `issues/…`. The short form still answers, but it is",
    "absent from Sentry's current API description, and an integration should",
    "not depend on an endpoint its vendor no longer documents.",
    "",
    "`count` and `userCount` arrive as strings. They are declared as numbers",
    'and coerced, because a model comparing "9" with 10 gets the wrong',
    "answer and a model comparing 9 with 10 does not.",
    "",
    "The organization and project are action arguments rather than",
    "constructor options: one token commonly spans several projects, and an",
    "agent that cannot say which one it means is less useful, not safer.",
  ],
  actions: [
    {
      name: "listIssues",
      summary: "List a project's issues, most recent first.",
      useCases: [
        "what is breaking",
        "list sentry issues",
        "what errors are happening",
        "show unresolved issues",
        "what is the top error today",
      ],
      keywords: ["error", "exception", "crash", "triage"],
      sideEffects: "read",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        project: { type: "string", describe: "Project slug." },
        query: {
          type: "string",
          default: "is:unresolved",
          optional: true,
          describe: 'Sentry search syntax, e.g. "is:unresolved level:error".',
        },
        statsPeriod: {
          type: "enum",
          values: ["1h", "24h", "14d", "30d"],
          default: "24h",
          optional: true,
        },
        limit: { type: "int", min: 1, max: 100, default: 25, optional: true },
      },
      request: {
        method: "GET",
        path: "projects/{organization}/{project}/issues/",
        query: { query: "$query", statsPeriod: "$statsPeriod", limit: "$limit" },
      },
      output: {
        type: "object",
        fields: { issues: { type: "array", from: "", item: issueItem } },
      },
      args: { organization: "acme", project: "web" },
      sample: [sampleIssue],
      expect: { issues: [expectedIssue] },
    },

    {
      name: "searchIssues",
      summary: "Search issues across every project in an organization.",
      useCases: [
        "search sentry",
        "find an error across projects",
        "what is failing anywhere",
        "issues mentioning a message",
        "errors assigned to me",
      ],
      sideEffects: "read",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        query: {
          type: "string",
          default: "is:unresolved",
          optional: true,
          describe: 'e.g. "is:unresolved assigned:me" or "message:timeout".',
        },
        statsPeriod: {
          type: "enum",
          values: ["1h", "24h", "14d", "30d"],
          default: "24h",
          optional: true,
        },
        limit: { type: "int", min: 1, max: 100, default: 25, optional: true },
      },
      request: {
        method: "GET",
        path: "organizations/{organization}/issues/",
        query: { query: "$query", statsPeriod: "$statsPeriod", limit: "$limit" },
      },
      output: {
        type: "object",
        fields: { issues: { type: "array", from: "", item: issueItem } },
      },
      args: { organization: "acme" },
      sample: [sampleIssue],
      expect: { issues: [expectedIssue] },
    },

    {
      name: "getIssue",
      summary: "Read one issue in full, with its first and last occurrence.",
      useCases: ["read a sentry issue", "how often does this error happen", "details of an issue"],
      sideEffects: "read",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        issueId: { type: "string", describe: "Numeric issue id from sentry.listIssues." },
      },
      request: { method: "GET", path: "organizations/{organization}/issues/{issueId}/" },
      output: issueItem,
      args: { organization: "acme", issueId: "1001" },
      sample: sampleIssue,
      expect: expectedIssue,
    },

    {
      name: "listIssueEvents",
      summary: "List recent events for an issue, newest first.",
      useCases: [
        "recent events for this error",
        "what request triggered it",
        "sample events for an issue",
        "how is this error reproduced",
      ],
      sideEffects: "read",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        issueId: { type: "string" },
      },
      request: { method: "GET", path: "organizations/{organization}/issues/{issueId}/events/" },
      output: {
        type: "object",
        fields: {
          events: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "string", from: "eventID" },
                message: { type: "string", optional: true },
                title: { type: "string", optional: true },
                platform: { type: "string", optional: true },
                dateCreated: { type: "string" },
                tags: { type: "json", optional: true },
              },
            },
          },
        },
      },
      args: { organization: "acme", issueId: "1001" },
      sample: [
        {
          eventID: "deadbeef",
          message: "TypeError: undefined is not a function",
          title: "TypeError",
          platform: "javascript",
          dateCreated: "2026-11-24T08:00:00Z",
          tags: [{ key: "browser", value: "Safari 17.4" }],
        },
      ],
      expect: {
        events: [
          {
            id: "deadbeef",
            message: "TypeError: undefined is not a function",
            title: "TypeError",
            platform: "javascript",
            dateCreated: "2026-11-24T08:00:00Z",
            tags: [{ key: "browser", value: "Safari 17.4" }],
          },
        ],
      },
    },

    {
      name: "getEvent",
      summary: "Read one event in full, including its stack trace entries.",
      useCases: [
        "show me the stack trace",
        "read the latest event for this issue",
        "what was the request that failed",
        "debug an error",
      ],
      keywords: ["stacktrace", "traceback", "debug"],
      sideEffects: "read",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        issueId: { type: "string" },
        eventId: {
          type: "string",
          default: "latest",
          optional: true,
          describe: 'An event id, or "latest" / "oldest".',
        },
      },
      request: {
        method: "GET",
        path: "organizations/{organization}/issues/{issueId}/events/{eventId}/",
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string", from: "eventID" },
          title: { type: "string", optional: true },
          message: { type: "string", optional: true },
          platform: { type: "string", optional: true },
          dateCreated: { type: "string" },
          entries: {
            type: "json",
            optional: true,
            describe: "Stack trace, request and breadcrumbs.",
          },
          tags: { type: "json", optional: true },
        },
      },
      args: { organization: "acme", issueId: "1001" },
      sample: {
        eventID: "deadbeef",
        title: "TypeError",
        message: "undefined is not a function",
        platform: "javascript",
        dateCreated: "2026-11-24T08:00:00Z",
        entries: [{ type: "exception", data: { values: [{ type: "TypeError" }] } }],
        tags: [{ key: "browser", value: "Safari 17.4" }],
      },
      expect: {
        id: "deadbeef",
        title: "TypeError",
        message: "undefined is not a function",
        platform: "javascript",
        dateCreated: "2026-11-24T08:00:00Z",
        entries: [{ type: "exception", data: { values: [{ type: "TypeError" }] } }],
        tags: [{ key: "browser", value: "Safari 17.4" }],
      },
    },

    {
      name: "setIssueStatus",
      summary: "Resolve, ignore, or reopen an issue.",
      useCases: [
        "resolve a sentry issue",
        "mark this error fixed",
        "ignore an issue",
        "reopen an issue",
        "mute an error",
      ],
      sideEffects: "write",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        issueId: { type: "string" },
        status: {
          type: "enum",
          values: ["resolved", "resolvedInNextRelease", "unresolved", "ignored"],
          default: "resolved",
          optional: true,
        },
      },
      request: {
        method: "PUT",
        path: "organizations/{organization}/issues/{issueId}/",
        body: { status: "$status" },
      },
      output: {
        type: "object",
        fields: { id: { type: "string" }, status: { type: "string" } },
      },
      args: { organization: "acme", issueId: "1001" },
      sample: { id: "1001", status: "resolved" },
      expect: { id: "1001", status: "resolved" },
    },

    {
      name: "assignIssue",
      summary: "Assign an issue to a user or team.",
      useCases: ["assign a sentry issue", "give this error to someone", "who should fix this"],
      sideEffects: "write",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        issueId: { type: "string" },
        assignedTo: {
          type: "string",
          describe: 'A username or email, or "team:<slug>". Empty string unassigns.',
        },
      },
      request: {
        method: "PUT",
        path: "organizations/{organization}/issues/{issueId}/",
        body: { assignedTo: "$assignedTo" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          assignedTo: { type: "string", from: "assignedTo.name", optional: true },
        },
      },
      args: { organization: "acme", issueId: "1001", assignedTo: "ada@example.com" },
      sample: { id: "1001", assignedTo: { name: "Ada Lovelace" } },
      expect: { id: "1001", assignedTo: "Ada Lovelace" },
    },

    {
      name: "setIssuePriority",
      summary: "Set an issue's priority.",
      useCases: ["set issue priority", "mark this error high priority", "deprioritise an issue"],
      sideEffects: "write",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        issueId: { type: "string" },
        priority: { type: "enum", values: ["high", "medium", "low"] },
      },
      request: {
        method: "PUT",
        path: "organizations/{organization}/issues/{issueId}/",
        body: { priority: "$priority" },
      },
      output: {
        type: "object",
        fields: { id: { type: "string" }, priority: { type: "string", optional: true } },
      },
      args: { organization: "acme", issueId: "1001", priority: "high" },
      sample: { id: "1001", priority: "high" },
      expect: { id: "1001", priority: "high" },
    },

    {
      name: "deleteIssue",
      summary: "Delete an issue and every event in it. Sentry answers with no content.",
      useCases: ["delete a sentry issue", "remove an error permanently", "purge an issue"],
      sideEffects: "destructive",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        issueId: { type: "string" },
      },
      request: { method: "DELETE", path: "organizations/{organization}/issues/{issueId}/" },
      // Sentry answers 202 with an empty body: there is nothing to map, and
      // the run result's own status is what says it worked.
      output: { type: "object", fields: {} },
      args: { organization: "acme", issueId: "1001" },
      sample: {},
      expect: {},
    },

    {
      name: "listIssueTagValues",
      summary: "Break an issue down by a tag, e.g. which browsers or releases it hits.",
      useCases: [
        "which browsers does this error affect",
        "what release introduced this",
        "break this issue down by tag",
        "which users hit this error",
      ],
      sideEffects: "read",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        issueId: { type: "string" },
        key: { type: "string", describe: 'Tag name, e.g. "browser", "release", "environment".' },
      },
      request: {
        method: "GET",
        path: "organizations/{organization}/issues/{issueId}/tags/{key}/",
      },
      output: {
        type: "object",
        fields: {
          key: { type: "string" },
          uniqueValues: { type: "number", optional: true },
          totalValues: { type: "number", optional: true },
          values: {
            type: "array",
            from: "topValues",
            item: {
              type: "object",
              fields: {
                value: { type: "string" },
                count: { type: "number" },
                lastSeen: { type: "string", optional: true },
              },
            },
          },
        },
      },
      args: { organization: "acme", issueId: "1001", key: "browser" },
      sample: {
        key: "browser",
        uniqueValues: 2,
        totalValues: 137,
        topValues: [{ value: "Safari 17.4", count: 120, lastSeen: "2026-11-24T08:00:00Z" }],
      },
      expect: {
        key: "browser",
        uniqueValues: 2,
        totalValues: 137,
        values: [{ value: "Safari 17.4", count: 120, lastSeen: "2026-11-24T08:00:00Z" }],
      },
    },

    {
      name: "bulkSetIssueStatus",
      summary: "Resolve or ignore every issue in a project matching a search.",
      useCases: [
        "resolve all issues matching",
        "bulk resolve sentry issues",
        "ignore every error from this release",
        "clear the backlog of old errors",
      ],
      sideEffects: "destructive",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        project: { type: "string", describe: "Project slug." },
        query: {
          type: "string",
          describe: 'Which issues to change, e.g. "is:unresolved age:+30d".',
        },
        status: {
          type: "enum",
          values: ["resolved", "ignored", "unresolved"],
          default: "resolved",
          optional: true,
        },
      },
      request: {
        method: "PUT",
        path: "projects/{organization}/{project}/issues/",
        query: { query: "$query" },
        body: { status: "$status" },
      },
      output: {
        type: "object",
        fields: { status: { type: "string", optional: true } },
      },
      args: {
        organization: "acme",
        project: "web",
        query: "is:unresolved age:+30d",
      },
      sample: { status: "resolved" },
      expect: { status: "resolved" },
    },

    {
      name: "listProjects",
      summary: "List an organization's projects, with the slugs other actions need.",
      useCases: ["list sentry projects", "what projects exist", "find a project slug"],
      sideEffects: "read",
      input: { organization: { type: "string", describe: "Organization slug." } },
      request: { method: "GET", path: "organizations/{organization}/projects/" },
      output: {
        type: "object",
        fields: {
          projects: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                slug: { type: "string" },
                name: { type: "string" },
                platform: { type: "string", optional: true },
                dateCreated: { type: "string", optional: true },
              },
            },
          },
        },
      },
      args: { organization: "acme" },
      sample: [
        {
          id: "7",
          slug: "web",
          name: "Web",
          platform: "javascript-react",
          dateCreated: "2026-01-01T00:00:00Z",
        },
      ],
      expect: {
        projects: [
          {
            id: "7",
            slug: "web",
            name: "Web",
            platform: "javascript-react",
            dateCreated: "2026-01-01T00:00:00Z",
          },
        ],
      },
    },

    {
      name: "getProject",
      summary: "Read one project's settings and platform.",
      useCases: ["read a sentry project", "what platform is this project", "project details"],
      sideEffects: "read",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        project: { type: "string", describe: "Project slug." },
      },
      request: { method: "GET", path: "projects/{organization}/{project}/" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          slug: { type: "string" },
          name: { type: "string" },
          platform: { type: "string", optional: true },
          organization: { type: "string", from: "organization.slug", optional: true },
        },
      },
      args: { organization: "acme", project: "web" },
      sample: {
        id: "7",
        slug: "web",
        name: "Web",
        platform: "javascript-react",
        organization: { slug: "acme" },
      },
      expect: {
        id: "7",
        slug: "web",
        name: "Web",
        platform: "javascript-react",
        organization: "acme",
      },
    },

    {
      name: "listReleases",
      summary: "List an organization's releases, newest first.",
      useCases: [
        "list sentry releases",
        "what version is deployed",
        "recent releases",
        "release health",
      ],
      keywords: ["deploy", "version"],
      sideEffects: "read",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        query: { type: "string", optional: true, describe: "Match on version." },
      },
      request: {
        method: "GET",
        path: "organizations/{organization}/releases/",
        query: { query: "$query" },
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
                version: { type: "string" },
                shortVersion: { type: "string", optional: true },
                dateCreated: { type: "string" },
                dateReleased: { type: "string", optional: true },
                commitCount: { type: "number", optional: true },
                deployCount: { type: "number", optional: true },
                newGroups: {
                  type: "number",
                  optional: true,
                  describe: "New issues in this release.",
                },
              },
            },
          },
        },
      },
      args: { organization: "acme" },
      sample: [
        {
          version: "web@1.2.0",
          shortVersion: "1.2.0",
          dateCreated: "2026-11-20T09:00:00Z",
          dateReleased: "2026-11-20T10:00:00Z",
          commitCount: 12,
          deployCount: 1,
          newGroups: 3,
        },
      ],
      expect: {
        releases: [
          {
            version: "web@1.2.0",
            shortVersion: "1.2.0",
            dateCreated: "2026-11-20T09:00:00Z",
            dateReleased: "2026-11-20T10:00:00Z",
            commitCount: 12,
            deployCount: 1,
            newGroups: 3,
          },
        ],
      },
    },

    {
      name: "getRelease",
      summary: "Read one release, with its commit and deploy counts.",
      useCases: ["read a sentry release", "when was this version released", "release details"],
      sideEffects: "read",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        version: { type: "string", describe: "Release version string." },
      },
      request: { method: "GET", path: "organizations/{organization}/releases/{version}/" },
      output: {
        type: "object",
        fields: {
          version: { type: "string" },
          dateCreated: { type: "string" },
          dateReleased: { type: "string", optional: true },
          commitCount: { type: "number", optional: true },
          deployCount: { type: "number", optional: true },
          newGroups: { type: "number", optional: true },
          url: { type: "string", optional: true },
        },
      },
      args: { organization: "acme", version: "web@1.2.0" },
      sample: {
        version: "web@1.2.0",
        dateCreated: "2026-11-20T09:00:00Z",
        dateReleased: "2026-11-20T10:00:00Z",
        commitCount: 12,
        deployCount: 1,
        newGroups: 3,
        url: "https://github.com/acme/web/releases/tag/v1.2.0",
      },
      expect: {
        version: "web@1.2.0",
        dateCreated: "2026-11-20T09:00:00Z",
        dateReleased: "2026-11-20T10:00:00Z",
        commitCount: 12,
        deployCount: 1,
        newGroups: 3,
        url: "https://github.com/acme/web/releases/tag/v1.2.0",
      },
    },

    {
      name: "createRelease",
      summary: "Register a release for one or more projects.",
      useCases: ["create a sentry release", "tell sentry we deployed", "register a version"],
      sideEffects: "write",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        version: { type: "string", describe: "Version string, e.g. web@1.3.0." },
        projects: { type: "string[]", describe: "Project slugs this release covers." },
        url: { type: "string", optional: true, describe: "Link to the release notes." },
      },
      request: {
        method: "POST",
        path: "organizations/{organization}/releases/",
        body: { version: "$version", projects: "$projects", url: "$url" },
      },
      output: {
        type: "object",
        fields: {
          version: { type: "string" },
          dateCreated: { type: "string" },
        },
      },
      args: { organization: "acme", version: "web@1.3.0", projects: ["web"] },
      sample: { version: "web@1.3.0", dateCreated: "2026-11-24T09:00:00Z" },
      expect: { version: "web@1.3.0", dateCreated: "2026-11-24T09:00:00Z" },
    },

    {
      name: "listReleaseCommits",
      summary: "List the commits that went into a release.",
      useCases: [
        "what shipped in this release",
        "commits in a sentry release",
        "what changed between versions",
      ],
      sideEffects: "read",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        version: { type: "string" },
      },
      request: {
        method: "GET",
        path: "organizations/{organization}/releases/{version}/commits/",
      },
      output: {
        type: "object",
        fields: {
          commits: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                message: { type: "string", optional: true },
                author: { type: "string", from: "author.name", optional: true },
                dateCreated: { type: "string", optional: true },
              },
            },
          },
        },
      },
      args: { organization: "acme", version: "web@1.2.0" },
      sample: [
        {
          id: "abc1234",
          message: "fix(auth): accept Safari cookies",
          author: { name: "Ada" },
          dateCreated: "2026-11-20T08:00:00Z",
        },
      ],
      expect: {
        commits: [
          {
            id: "abc1234",
            message: "fix(auth): accept Safari cookies",
            author: "Ada",
            dateCreated: "2026-11-20T08:00:00Z",
          },
        ],
      },
    },

    {
      name: "listReleaseDeploys",
      summary: "List the environments a release was deployed to.",
      useCases: [
        "where is this release deployed",
        "deploy history",
        "is this version in production",
      ],
      sideEffects: "read",
      input: {
        organization: { type: "string", describe: "Organization slug." },
        version: { type: "string" },
      },
      request: {
        method: "GET",
        path: "organizations/{organization}/releases/{version}/deploys/",
      },
      output: {
        type: "object",
        fields: {
          deploys: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                environment: { type: "string" },
                name: { type: "string", optional: true },
                dateStarted: { type: "string", optional: true },
                dateFinished: { type: "string", optional: true },
                url: { type: "string", optional: true },
              },
            },
          },
        },
      },
      args: { organization: "acme", version: "web@1.2.0" },
      sample: [
        {
          id: "9001",
          environment: "production",
          name: "web@1.2.0 to production",
          dateFinished: "2026-11-20T10:00:00Z",
        },
      ],
      expect: {
        deploys: [
          {
            id: "9001",
            environment: "production",
            name: "web@1.2.0 to production",
            dateFinished: "2026-11-20T10:00:00Z",
          },
        ],
      },
    },

    {
      name: "listTeams",
      summary: "List an organization's teams.",
      useCases: ["list sentry teams", "what teams exist", "find a team slug"],
      sideEffects: "read",
      input: { organization: { type: "string", describe: "Organization slug." } },
      request: { method: "GET", path: "organizations/{organization}/teams/" },
      output: {
        type: "object",
        fields: {
          teams: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                slug: { type: "string" },
                name: { type: "string" },
                memberCount: { type: "number", optional: true },
              },
            },
          },
        },
      },
      args: { organization: "acme" },
      sample: [{ id: "3", slug: "backend", name: "Backend", memberCount: 6 }],
      expect: { teams: [{ id: "3", slug: "backend", name: "Backend", memberCount: 6 }] },
    },

    {
      name: "listMembers",
      summary: "List an organization's members, with the emails assignment needs.",
      useCases: [
        "who is in this sentry org",
        "list sentry members",
        "find someone to assign an issue to",
      ],
      sideEffects: "read",
      input: { organization: { type: "string", describe: "Organization slug." } },
      request: { method: "GET", path: "organizations/{organization}/members/" },
      output: {
        type: "object",
        fields: {
          members: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                email: { type: "string", optional: true },
                name: { type: "string", optional: true },
                role: { type: "string", from: "orgRole", optional: true },
                pending: { type: "boolean", optional: true },
              },
            },
          },
        },
      },
      args: { organization: "acme" },
      sample: [
        {
          id: "11",
          email: "ada@example.com",
          name: "Ada Lovelace",
          orgRole: "member",
          pending: false,
        },
      ],
      expect: {
        members: [
          {
            id: "11",
            email: "ada@example.com",
            name: "Ada Lovelace",
            role: "member",
            pending: false,
          },
        ],
      },
    },
  ],
};
