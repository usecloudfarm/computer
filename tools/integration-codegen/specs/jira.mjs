/** Jira Cloud: issues over the v3 REST API, with an email + API token pair. */
export default {
  id: "jira",
  name: "Jira",
  description:
    "Issue tracking. Search issues with JQL, read one, create issues, comment on them, and list projects.",
  npmDescription: "Jira Cloud as a Computer app: search, create and comment on issues",
  icon: "https://cdn.simpleicons.org/jira",
  docsUrl: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/",
  credentials:
    "Create an API token at id.atlassian.com/manage-profile/security/api-tokens, and pass it with the Atlassian account email as `username`. Jira Cloud authenticates the pair over HTTP Basic.",
  auth: { kind: "basic" },
  options: {
    site: {
      describe: 'Atlassian site name — the "acme" in acme.atlassian.net.',
      sample: "acme",
    },
  },
  baseUrl: "https://{site}.atlassian.net/rest/api/3",
  allowedHosts: ["{site}.atlassian.net"],
  notes: [
    "Jira Cloud is per-site, so `site` is a constructor option rather than an",
    "argument: it decides the base URL and therefore the egress allowlist, and",
    "a value that decides where a credentialed request may go must not arrive",
    "from a model.",
    "",
    "Descriptions and comments are Atlassian Document Format, not markdown.",
    "The spec wraps plain text in the smallest valid document, which is what",
    "an agent wants in the overwhelming majority of cases.",
  ],
  actions: [
    {
      name: "searchIssues",
      summary: "Search issues with JQL.",
      useCases: [
        "search jira",
        "find a jira ticket",
        "what issues are assigned to me in jira",
        "list open bugs in jira",
        "what is in this sprint",
      ],
      keywords: ["jql", "ticket", "sprint"],
      sideEffects: "read",
      input: {
        jql: {
          type: "string",
          min: 1,
          describe: 'JQL, e.g. "project = ENG AND statusCategory != Done ORDER BY updated DESC".',
        },
        limit: { type: "int", min: 1, max: 100, default: 25, optional: true },
      },
      request: {
        method: "GET",
        path: "search/jql",
        query: {
          jql: "$jql",
          maxResults: "$limit",
          fields: "summary,status,assignee,updated",
        },
      },
      output: {
        type: "object",
        fields: {
          issues: {
            type: "array",
            from: "issues",
            item: {
              type: "object",
              fields: {
                key: { type: "string", describe: 'Human reference, e.g. "ENG-42".' },
                summary: { type: "string", from: "fields.summary" },
                status: { type: "string", from: "fields.status.name" },
                assignee: { type: "string", from: "fields.assignee.displayName", optional: true },
                updated: { type: "string", from: "fields.updated", optional: true },
              },
            },
          },
        },
      },
      args: { jql: "project = ENG ORDER BY updated DESC" },
      sample: {
        issues: [
          {
            key: "ENG-42",
            fields: {
              summary: "Login fails on Safari",
              status: { name: "In Progress" },
              assignee: { displayName: "Ada Lovelace" },
              updated: "2026-11-20T09:00:00.000+0000",
            },
          },
        ],
      },
      expect: {
        issues: [
          {
            key: "ENG-42",
            summary: "Login fails on Safari",
            status: "In Progress",
            assignee: "Ada Lovelace",
            updated: "2026-11-20T09:00:00.000+0000",
          },
        ],
      },
    },

    {
      name: "getIssue",
      summary: "Read one issue by key.",
      useCases: ["read a jira issue", "what is ENG-42", "look up a ticket by key"],
      sideEffects: "read",
      input: { key: { type: "string", describe: 'Issue key, e.g. "ENG-42".' } },
      request: {
        method: "GET",
        path: "issue/{key}",
        query: { fields: "summary,status,assignee,description,created" },
      },
      output: {
        type: "object",
        fields: {
          key: { type: "string" },
          summary: { type: "string", from: "fields.summary" },
          status: { type: "string", from: "fields.status.name" },
          assignee: { type: "string", from: "fields.assignee.displayName", optional: true },
          created: { type: "string", from: "fields.created", optional: true },
          description: {
            type: "json",
            from: "fields.description",
            optional: true,
            describe: "Atlassian Document Format.",
          },
        },
      },
      args: { key: "ENG-42" },
      sample: {
        key: "ENG-42",
        fields: {
          summary: "Login fails on Safari",
          status: { name: "In Progress" },
          assignee: { displayName: "Ada Lovelace" },
          created: "2026-11-18T12:00:00.000+0000",
          description: null,
        },
      },
      expect: {
        key: "ENG-42",
        summary: "Login fails on Safari",
        status: "In Progress",
        assignee: "Ada Lovelace",
        created: "2026-11-18T12:00:00.000+0000",
      },
    },

    {
      name: "createIssue",
      summary: "Create an issue in a project.",
      useCases: ["create a jira issue", "file a jira ticket", "open a task in jira", "log a bug"],
      sideEffects: "write",
      input: {
        projectKey: { type: "string", describe: 'Project key, e.g. "ENG".' },
        summary: { type: "string", min: 1, describe: "One-line title." },
        issueType: { type: "string", default: "Task", optional: true },
      },
      request: {
        method: "POST",
        path: "issue",
        body: {
          fields: {
            project: { key: "$projectKey" },
            summary: "$summary",
            issuetype: { name: "$issueType" },
          },
        },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          key: { type: "string" },
          url: { type: "string", from: "self" },
        },
      },
      args: { projectKey: "ENG", summary: "Login fails on Safari" },
      sample: {
        id: "10042",
        key: "ENG-42",
        self: "https://acme.atlassian.net/rest/api/3/issue/10042",
      },
      expect: {
        id: "10042",
        key: "ENG-42",
        url: "https://acme.atlassian.net/rest/api/3/issue/10042",
      },
    },

    {
      name: "addComment",
      summary: "Comment on an issue.",
      useCases: ["comment on a jira issue", "reply on a jira ticket", "add a note to ENG-42"],
      sideEffects: "write",
      input: {
        key: { type: "string", describe: 'Issue key, e.g. "ENG-42".' },
        text: { type: "string", min: 1, describe: "Plain text; wrapped in ADF for you." },
      },
      request: {
        method: "POST",
        path: "issue/{key}/comment",
        body: {
          body: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "$text" }] }],
          },
        },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          created: { type: "string" },
          author: { type: "string", from: "author.displayName", optional: true },
        },
      },
      args: { key: "ENG-42", text: "Reproduced on 17.4." },
      sample: {
        id: "20001",
        created: "2026-11-24T08:30:00.000+0000",
        author: { displayName: "Ada Lovelace" },
      },
      expect: {
        id: "20001",
        created: "2026-11-24T08:30:00.000+0000",
        author: "Ada Lovelace",
      },
    },

    {
      name: "listProjects",
      summary: "List projects, with the keys other actions need.",
      useCases: ["list jira projects", "what projects exist in jira", "find a project key"],
      sideEffects: "read",
      input: {
        limit: { type: "int", min: 1, max: 100, default: 50, optional: true },
      },
      request: { method: "GET", path: "project/search", query: { maxResults: "$limit" } },
      output: {
        type: "object",
        fields: {
          projects: {
            type: "array",
            from: "values",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                key: { type: "string" },
                name: { type: "string" },
              },
            },
          },
        },
      },
      args: {},
      sample: { values: [{ id: "10000", key: "ENG", name: "Engineering" }] },
      expect: { projects: [{ id: "10000", key: "ENG", name: "Engineering" }] },
    },
  ],
};
