/** Linear: issue tracking over a single GraphQL endpoint. */
export default {
  id: "linear",
  name: "Linear",
  description:
    "Issue tracking. Create issues, search them, comment on one, list teams, and read what is assigned to you.",
  npmDescription: "Linear as a Computer app: create, search and comment on issues",
  docsUrl: "https://developers.linear.app/docs/graphql/working-with-the-graphql-api",
  credentials:
    "Create a personal API key in Linear under Settings → Security & access → Personal API keys.",
  auth: {
    kind: "apiKey",
    // Linear wants the raw key, not `Bearer <key>`.
    prefix: "",
    describe: "A Linear personal API key (lin_api_…).",
  },
  baseUrl: "https://api.linear.app",
  allowedHosts: ["api.linear.app"],
  graphqlPath: "graphql",
  validate: { kind: "graphqlErrors" },
  notes: [
    "Linear has no REST API, so every action is one POST to /graphql with a",
    "document written out in the spec. That is a feature for an agent: the",
    "query decides the response shape, so an action returns the five fields a",
    "model needs rather than the forty an issue has.",
    "",
    "`createIssue` takes a team id rather than a team key because that is what",
    "the mutation takes; `listTeams` is how an agent gets one, and the two",
    "chain in a single code-mode script.",
  ],
  actions: [
    {
      name: "listTeams",
      summary: "List the teams this key can see, with the ids other actions need.",
      useCases: ["list teams", "what teams exist", "find a team id", "which boards are there"],
      keywords: ["board", "workspace", "project"],
      sideEffects: "read",
      input: {
        limit: { type: "int", min: 1, max: 250, default: 50, optional: true },
      },
      request: {
        graphql: {
          query: `query Teams($first: Int) {
  teams(first: $first) {
    nodes { id key name description }
  }
}`,
          variables: { first: "$limit" },
        },
      },
      output: {
        type: "object",
        fields: {
          teams: {
            type: "array",
            from: "data.teams.nodes",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                key: { type: "string", describe: 'Short prefix, e.g. "ENG".' },
                name: { type: "string" },
                description: { type: "string", optional: true },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: {
          teams: {
            nodes: [{ id: "team_1", key: "ENG", name: "Engineering", description: null }],
          },
        },
      },
      expect: { teams: [{ id: "team_1", key: "ENG", name: "Engineering" }] },
    },

    {
      name: "createIssue",
      summary: "Open an issue on a team's board.",
      useCases: [
        "create an issue",
        "file a bug",
        "open a ticket",
        "add a task to linear",
        "log a feature request",
      ],
      keywords: ["ticket", "bug", "task"],
      sideEffects: "write",
      input: {
        teamId: { type: "string", describe: "Team id from linear.listTeams." },
        title: { type: "string", min: 1 },
        description: { type: "string", optional: true, describe: "Markdown body." },
        assigneeId: { type: "string", optional: true, describe: "User id from linear.listUsers." },
        priority: {
          type: "int",
          min: 0,
          max: 4,
          optional: true,
          describe: "0 none, 1 urgent, 2 high, 3 normal, 4 low.",
        },
        projectId: { type: "string", optional: true },
        parentId: { type: "string", optional: true, describe: "Makes this a sub-issue." },
        labelIds: { type: "string[]", optional: true },
      },
      request: {
        graphql: {
          query: `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    issue { id identifier title url }
  }
}`,
          variables: {
            input: {
              teamId: "$teamId",
              title: "$title",
              description: "$description",
              assigneeId: "$assigneeId",
              priority: "$priority",
              projectId: "$projectId",
              parentId: "$parentId",
              labelIds: "$labelIds",
            },
          },
        },
      },
      output: {
        type: "object",
        from: "data.issueCreate.issue",
        fields: {
          id: { type: "string" },
          identifier: { type: "string", describe: 'Human reference, e.g. "ENG-42".' },
          title: { type: "string" },
          url: { type: "string" },
        },
      },
      args: { teamId: "team_1", title: "Login fails on Safari" },
      example: { teamId: "team_1", title: "Login fails on Safari" },
      sample: {
        data: {
          issueCreate: {
            issue: {
              id: "issue_1",
              identifier: "ENG-42",
              title: "Login fails on Safari",
              url: "https://linear.app/acme/issue/ENG-42",
            },
          },
        },
      },
      expect: {
        id: "issue_1",
        identifier: "ENG-42",
        title: "Login fails on Safari",
        url: "https://linear.app/acme/issue/ENG-42",
      },
    },

    {
      name: "searchIssues",
      summary: "Search issues by text across the workspace.",
      useCases: [
        "search issues",
        "find a ticket",
        "is there an issue about",
        "look up a bug",
        "what issues mention",
      ],
      sideEffects: "read",
      input: {
        query: { type: "string", min: 1, describe: "Free text; Linear matches title and body." },
        limit: { type: "int", min: 1, max: 50, default: 25, optional: true },
      },
      request: {
        graphql: {
          query: `query SearchIssues($term: String!, $first: Int) {
  searchIssues(term: $term, first: $first) {
    nodes {
      id
      identifier
      title
      url
      state { name }
      assignee { name }
    }
  }
}`,
          variables: { term: "$query", first: "$limit" },
        },
      },
      output: {
        type: "object",
        fields: {
          issues: {
            type: "array",
            from: "data.searchIssues.nodes",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                identifier: { type: "string" },
                title: { type: "string" },
                url: { type: "string" },
                state: { type: "string", from: "state.name" },
                assignee: { type: "string", from: "assignee.name", optional: true },
              },
            },
          },
        },
      },
      args: { query: "safari login" },
      sample: {
        data: {
          searchIssues: {
            nodes: [
              {
                id: "issue_1",
                identifier: "ENG-42",
                title: "Login fails on Safari",
                url: "https://linear.app/acme/issue/ENG-42",
                state: { name: "Todo" },
                assignee: { name: "Ada" },
              },
              {
                id: "issue_2",
                identifier: "ENG-43",
                title: "Safari autofill",
                url: "https://linear.app/acme/issue/ENG-43",
                state: { name: "Done" },
                assignee: null,
              },
            ],
          },
        },
      },
      expect: {
        issues: [
          {
            id: "issue_1",
            identifier: "ENG-42",
            title: "Login fails on Safari",
            url: "https://linear.app/acme/issue/ENG-42",
            state: "Todo",
            assignee: "Ada",
          },
          {
            id: "issue_2",
            identifier: "ENG-43",
            title: "Safari autofill",
            url: "https://linear.app/acme/issue/ENG-43",
            state: "Done",
          },
        ],
      },
    },

    {
      name: "commentOnIssue",
      summary: "Add a comment to an issue.",
      useCases: ["comment on an issue", "reply on a ticket", "leave a note on a bug"],
      sideEffects: "write",
      input: {
        issueId: { type: "string", describe: "Issue id, not the ENG-42 identifier." },
        body: { type: "string", min: 1, describe: "Markdown comment." },
      },
      request: {
        graphql: {
          query: `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    comment { id url }
  }
}`,
          variables: { input: { issueId: "$issueId", body: "$body" } },
        },
      },
      output: {
        type: "object",
        from: "data.commentCreate.comment",
        fields: { id: { type: "string" }, url: { type: "string" } },
      },
      args: { issueId: "issue_1", body: "Reproduced on 17.4." },
      sample: {
        data: {
          commentCreate: {
            comment: { id: "comment_1", url: "https://linear.app/acme/issue/ENG-42#comment-1" },
          },
        },
      },
      expect: {
        id: "comment_1",
        url: "https://linear.app/acme/issue/ENG-42#comment-1",
      },
    },

    {
      name: "myIssues",
      summary: "Read the issues assigned to the key's own user.",
      useCases: [
        "what am i working on",
        "my issues",
        "my tickets",
        "what is assigned to me",
        "my linear queue",
      ],
      sideEffects: "read",
      input: {
        limit: { type: "int", min: 1, max: 100, default: 25, optional: true },
      },
      request: {
        graphql: {
          query: `query MyIssues($first: Int) {
  viewer {
    name
    assignedIssues(first: $first, orderBy: updatedAt) {
      nodes { id identifier title url state { name } }
    }
  }
}`,
          variables: { first: "$limit" },
        },
      },
      output: {
        type: "object",
        fields: {
          user: { type: "string", from: "data.viewer.name" },
          issues: {
            type: "array",
            from: "data.viewer.assignedIssues.nodes",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                identifier: { type: "string" },
                title: { type: "string" },
                url: { type: "string" },
                state: { type: "string", from: "state.name" },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: {
          viewer: {
            name: "Ada",
            assignedIssues: {
              nodes: [
                {
                  id: "issue_1",
                  identifier: "ENG-42",
                  title: "Login fails on Safari",
                  url: "https://linear.app/acme/issue/ENG-42",
                  state: { name: "In Progress" },
                },
              ],
            },
          },
        },
      },
      expect: {
        user: "Ada",
        issues: [
          {
            id: "issue_1",
            identifier: "ENG-42",
            title: "Login fails on Safari",
            url: "https://linear.app/acme/issue/ENG-42",
            state: "In Progress",
          },
        ],
      },
    },
    {
      name: "listIssues",
      summary: "List issues, filtered by team, state category or assignee.",
      useCases: [
        "list issues",
        "what is in progress",
        "what is on the backlog",
        "issues for this team",
        "what is assigned to someone",
        "open issues in linear",
      ],
      keywords: ["backlog", "board", "todo"],
      sideEffects: "read",
      input: {
        teamKey: { type: "string", optional: true, describe: 'Team key, e.g. "ENG".' },
        stateType: {
          type: "enum",
          values: ["triage", "backlog", "unstarted", "started", "completed", "canceled"],
          optional: true,
          describe: "State category, not the state name.",
        },
        assigneeId: { type: "string", optional: true },
        limit: { type: "int", min: 1, max: 100, default: 25, optional: true },
      },
      request: {
        graphql: {
          query: `query Issues($first: Int, $filter: IssueFilter) {
  issues(first: $first, filter: $filter, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      url
      priority
      priorityLabel
      updatedAt
      state { name type }
      assignee { name }
      team { key }
    }
  }
}`,
          variables: {
            first: "$limit",
            // Linear's filter is a nested object, and only the parts the agent
            // actually set may appear in it.
            filter: {
              raw: `{
  ...(teamKey === undefined ? {} : { team: { key: { eq: teamKey } } }),
  ...(stateType === undefined ? {} : { state: { type: { eq: stateType } } }),
  ...(assigneeId === undefined ? {} : { assignee: { id: { eq: assigneeId } } }),
}`,
              uses: ["teamKey", "stateType", "assigneeId"],
            },
          },
        },
      },
      output: {
        type: "object",
        fields: {
          issues: {
            type: "array",
            from: "data.issues.nodes",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                identifier: { type: "string" },
                title: { type: "string" },
                url: { type: "string" },
                priority: { type: "string", from: "priorityLabel", optional: true },
                state: { type: "string", from: "state.name" },
                stateType: { type: "string", from: "state.type" },
                assignee: { type: "string", from: "assignee.name", optional: true },
                team: { type: "string", from: "team.key", optional: true },
                updatedAt: { type: "string", optional: true },
              },
            },
          },
        },
      },
      args: { teamKey: "ENG" },
      sample: {
        data: {
          issues: {
            nodes: [
              {
                id: "issue_1",
                identifier: "ENG-42",
                title: "Login fails on Safari",
                url: "https://linear.app/acme/issue/ENG-42",
                priorityLabel: "Urgent",
                updatedAt: "2026-11-24T08:00:00.000Z",
                state: { name: "In Progress", type: "started" },
                assignee: { name: "Ada" },
                team: { key: "ENG" },
              },
            ],
          },
        },
      },
      expect: {
        issues: [
          {
            id: "issue_1",
            identifier: "ENG-42",
            title: "Login fails on Safari",
            url: "https://linear.app/acme/issue/ENG-42",
            priority: "Urgent",
            state: "In Progress",
            stateType: "started",
            assignee: "Ada",
            team: "ENG",
            updatedAt: "2026-11-24T08:00:00.000Z",
          },
        ],
      },
    },

    {
      name: "getIssue",
      summary: "Read one issue in full, with its description and labels.",
      useCases: ["read an issue", "what does ENG-42 say", "open a linear issue", "issue details"],
      sideEffects: "read",
      input: {
        issueId: { type: "string", describe: "Issue id, or its ENG-42 identifier." },
      },
      request: {
        graphql: {
          query: `query Issue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    priorityLabel
    estimate
    dueDate
    branchName
    state { name type }
    assignee { name }
    team { key }
    project { name }
    labels { nodes { name } }
  }
}`,
          variables: { id: "$issueId" },
        },
      },
      output: {
        type: "object",
        from: "data.issue",
        fields: {
          id: { type: "string" },
          identifier: { type: "string" },
          title: { type: "string" },
          description: { type: "string", optional: true },
          url: { type: "string" },
          priority: { type: "string", from: "priorityLabel", optional: true },
          estimate: { type: "number", optional: true },
          dueDate: { type: "string", optional: true },
          branchName: { type: "string", optional: true },
          state: { type: "string", from: "state.name" },
          assignee: { type: "string", from: "assignee.name", optional: true },
          team: { type: "string", from: "team.key", optional: true },
          project: { type: "string", from: "project.name", optional: true },
          labels: { type: "array", from: "labels.nodes", item: { type: "string", from: "name" } },
        },
      },
      args: { issueId: "ENG-42" },
      sample: {
        data: {
          issue: {
            id: "issue_1",
            identifier: "ENG-42",
            title: "Login fails on Safari",
            description: "Steps to reproduce…",
            url: "https://linear.app/acme/issue/ENG-42",
            priorityLabel: "Urgent",
            estimate: 3,
            dueDate: "2026-12-01",
            branchName: "ada/eng-42-login-fails-on-safari",
            state: { name: "In Progress", type: "started" },
            assignee: { name: "Ada" },
            team: { key: "ENG" },
            project: { name: "Auth revamp" },
            labels: { nodes: [{ name: "bug" }] },
          },
        },
      },
      expect: {
        id: "issue_1",
        identifier: "ENG-42",
        title: "Login fails on Safari",
        description: "Steps to reproduce…",
        url: "https://linear.app/acme/issue/ENG-42",
        priority: "Urgent",
        estimate: 3,
        dueDate: "2026-12-01",
        branchName: "ada/eng-42-login-fails-on-safari",
        state: "In Progress",
        assignee: "Ada",
        team: "ENG",
        project: "Auth revamp",
        labels: ["bug"],
      },
    },

    {
      name: "updateIssue",
      summary: "Change an issue: its state, assignee, title, priority, estimate or project.",
      useCases: [
        "move an issue to done",
        "change the state of an issue",
        "assign an issue",
        "reprioritise an issue",
        "rename an issue",
        "close a linear issue",
      ],
      keywords: ["move", "assign", "state", "triage"],
      sideEffects: "write",
      input: {
        issueId: { type: "string", describe: "Issue id, or its ENG-42 identifier." },
        title: { type: "string", optional: true },
        description: { type: "string", optional: true },
        stateId: {
          type: "string",
          optional: true,
          describe: "Workflow state id from linear.listWorkflowStates.",
        },
        assigneeId: { type: "string", optional: true, describe: "User id from linear.listUsers." },
        priority: {
          type: "int",
          min: 0,
          max: 4,
          optional: true,
          describe: "0 none, 1 urgent, 2 high, 3 normal, 4 low.",
        },
        estimate: { type: "int", min: 0, max: 21, optional: true },
        projectId: { type: "string", optional: true },
        dueDate: { type: "string", optional: true, describe: "ISO date, e.g. 2026-12-01." },
      },
      request: {
        graphql: {
          query: `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id
      identifier
      title
      url
      state { name }
      assignee { name }
    }
  }
}`,
          variables: {
            id: "$issueId",
            input: {
              title: "$title",
              description: "$description",
              stateId: "$stateId",
              assigneeId: "$assigneeId",
              priority: "$priority",
              estimate: "$estimate",
              projectId: "$projectId",
              dueDate: "$dueDate",
            },
          },
        },
      },
      output: {
        type: "object",
        from: "data.issueUpdate.issue",
        fields: {
          id: { type: "string" },
          identifier: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          state: { type: "string", from: "state.name" },
          assignee: { type: "string", from: "assignee.name", optional: true },
        },
      },
      args: { issueId: "ENG-42", stateId: "state_done" },
      sample: {
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: "issue_1",
              identifier: "ENG-42",
              title: "Login fails on Safari",
              url: "https://linear.app/acme/issue/ENG-42",
              state: { name: "Done" },
              assignee: { name: "Ada" },
            },
          },
        },
      },
      expect: {
        id: "issue_1",
        identifier: "ENG-42",
        title: "Login fails on Safari",
        url: "https://linear.app/acme/issue/ENG-42",
        state: "Done",
        assignee: "Ada",
      },
    },

    {
      name: "listWorkflowStates",
      summary: "List a team's workflow states, with the ids an issue move needs.",
      useCases: [
        "what states does this team have",
        "find the done state id",
        "list workflow states",
        "what columns are on the board",
      ],
      sideEffects: "read",
      input: {
        teamKey: { type: "string", describe: 'Team key, e.g. "ENG".' },
        limit: { type: "int", min: 1, max: 100, default: 50, optional: true },
      },
      request: {
        graphql: {
          query: `query WorkflowStates($first: Int, $filter: WorkflowStateFilter) {
  workflowStates(first: $first, filter: $filter) {
    nodes { id name type position team { key } }
  }
}`,
          variables: {
            first: "$limit",
            filter: { raw: "{ team: { key: { eq: teamKey } } }", uses: ["teamKey"] },
          },
        },
      },
      output: {
        type: "object",
        fields: {
          states: {
            type: "array",
            from: "data.workflowStates.nodes",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                name: { type: "string" },
                type: {
                  type: "string",
                  describe: "backlog, unstarted, started, completed, canceled.",
                },
                position: { type: "number", optional: true },
              },
            },
          },
        },
      },
      args: { teamKey: "ENG" },
      sample: {
        data: {
          workflowStates: {
            nodes: [
              {
                id: "state_done",
                name: "Done",
                type: "completed",
                position: 3,
                team: { key: "ENG" },
              },
            ],
          },
        },
      },
      expect: {
        states: [{ id: "state_done", name: "Done", type: "completed", position: 3 }],
      },
    },

    {
      name: "listUsers",
      summary: "List workspace members, with the ids assignment needs.",
      useCases: ["who is in this workspace", "list linear users", "find a user id to assign to"],
      sideEffects: "read",
      input: { limit: { type: "int", min: 1, max: 100, default: 50, optional: true } },
      request: {
        graphql: {
          query: `query Users($first: Int) {
  users(first: $first) {
    nodes { id name displayName email active }
  }
}`,
          variables: { first: "$limit" },
        },
      },
      output: {
        type: "object",
        fields: {
          users: {
            type: "array",
            from: "data.users.nodes",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                name: { type: "string" },
                displayName: { type: "string", optional: true },
                email: { type: "string", optional: true },
                active: { type: "boolean" },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: {
          users: {
            nodes: [
              {
                id: "user_1",
                name: "Ada Lovelace",
                displayName: "ada",
                email: "ada@example.com",
                active: true,
              },
            ],
          },
        },
      },
      expect: {
        users: [
          {
            id: "user_1",
            name: "Ada Lovelace",
            displayName: "ada",
            email: "ada@example.com",
            active: true,
          },
        ],
      },
    },

    {
      name: "listProjects",
      summary: "List projects, with their progress and target dates.",
      useCases: [
        "list projects",
        "what projects are running",
        "how is this project doing",
        "roadmap",
      ],
      sideEffects: "read",
      input: { limit: { type: "int", min: 1, max: 100, default: 25, optional: true } },
      request: {
        graphql: {
          query: `query Projects($first: Int) {
  projects(first: $first) {
    nodes {
      id
      name
      description
      url
      progress
      startDate
      targetDate
      status { name }
      lead { name }
    }
  }
}`,
          variables: { first: "$limit" },
        },
      },
      output: {
        type: "object",
        fields: {
          projects: {
            type: "array",
            from: "data.projects.nodes",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string", optional: true },
                url: { type: "string" },
                progress: { type: "number", describe: "0 to 1." },
                status: { type: "string", from: "status.name", optional: true },
                lead: { type: "string", from: "lead.name", optional: true },
                targetDate: { type: "string", optional: true },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: {
          projects: {
            nodes: [
              {
                id: "project_1",
                name: "Auth revamp",
                description: "Rebuild login",
                url: "https://linear.app/acme/project/auth-revamp",
                progress: 0.4,
                startDate: "2026-11-01",
                targetDate: "2026-12-15",
                status: { name: "In Progress" },
                lead: { name: "Ada" },
              },
            ],
          },
        },
      },
      expect: {
        projects: [
          {
            id: "project_1",
            name: "Auth revamp",
            description: "Rebuild login",
            url: "https://linear.app/acme/project/auth-revamp",
            progress: 0.4,
            status: "In Progress",
            lead: "Ada",
            targetDate: "2026-12-15",
          },
        ],
      },
    },

    {
      name: "getProject",
      summary: "Read one project, with its progress and lead.",
      useCases: ["read a project", "how far along is this project", "project details"],
      sideEffects: "read",
      input: { projectId: { type: "string" } },
      request: {
        graphql: {
          query: `query Project($id: String!) {
  project(id: $id) {
    id
    name
    description
    url
    progress
    startDate
    targetDate
    status { name }
    lead { name }
  }
}`,
          variables: { id: "$projectId" },
        },
      },
      output: {
        type: "object",
        from: "data.project",
        fields: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string", optional: true },
          url: { type: "string" },
          progress: { type: "number" },
          status: { type: "string", from: "status.name", optional: true },
          lead: { type: "string", from: "lead.name", optional: true },
          targetDate: { type: "string", optional: true },
        },
      },
      args: { projectId: "project_1" },
      sample: {
        data: {
          project: {
            id: "project_1",
            name: "Auth revamp",
            description: "Rebuild login",
            url: "https://linear.app/acme/project/auth-revamp",
            progress: 0.4,
            targetDate: "2026-12-15",
            status: { name: "In Progress" },
            lead: { name: "Ada" },
          },
        },
      },
      expect: {
        id: "project_1",
        name: "Auth revamp",
        description: "Rebuild login",
        url: "https://linear.app/acme/project/auth-revamp",
        progress: 0.4,
        status: "In Progress",
        lead: "Ada",
        targetDate: "2026-12-15",
      },
    },

    {
      name: "createProject",
      summary: "Create a project for one or more teams.",
      useCases: ["create a project", "start a new project in linear", "set up a roadmap item"],
      sideEffects: "write",
      input: {
        name: { type: "string", min: 1 },
        teamIds: { type: "string[]", describe: "Team ids from linear.listTeams." },
        description: { type: "string", optional: true },
        targetDate: { type: "string", optional: true, describe: "ISO date." },
      },
      request: {
        graphql: {
          query: `mutation ProjectCreate($input: ProjectCreateInput!) {
  projectCreate(input: $input) {
    success
    project { id name url }
  }
}`,
          variables: {
            input: {
              name: "$name",
              teamIds: "$teamIds",
              description: "$description",
              targetDate: "$targetDate",
            },
          },
        },
      },
      output: {
        type: "object",
        from: "data.projectCreate.project",
        fields: {
          id: { type: "string" },
          name: { type: "string" },
          url: { type: "string" },
        },
      },
      args: { name: "Auth revamp", teamIds: ["team_1"] },
      sample: {
        data: {
          projectCreate: {
            success: true,
            project: {
              id: "project_2",
              name: "Auth revamp",
              url: "https://linear.app/acme/project/auth-revamp",
            },
          },
        },
      },
      expect: {
        id: "project_2",
        name: "Auth revamp",
        url: "https://linear.app/acme/project/auth-revamp",
      },
    },

    {
      name: "listIssueComments",
      summary: "Read the comments on an issue.",
      useCases: [
        "read the comments on an issue",
        "what was discussed on this ticket",
        "issue thread",
      ],
      sideEffects: "read",
      input: {
        issueId: { type: "string" },
        limit: { type: "int", min: 1, max: 100, default: 50, optional: true },
      },
      request: {
        graphql: {
          query: `query Comments($first: Int, $filter: CommentFilter) {
  comments(first: $first, filter: $filter) {
    nodes { id body url createdAt user { name } }
  }
}`,
          variables: {
            first: "$limit",
            filter: { raw: "{ issue: { id: { eq: issueId } } }", uses: ["issueId"] },
          },
        },
      },
      output: {
        type: "object",
        fields: {
          comments: {
            type: "array",
            from: "data.comments.nodes",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                body: { type: "string" },
                url: { type: "string" },
                createdAt: { type: "string" },
                author: { type: "string", from: "user.name", optional: true },
              },
            },
          },
        },
      },
      args: { issueId: "issue_1" },
      sample: {
        data: {
          comments: {
            nodes: [
              {
                id: "comment_1",
                body: "Reproduced on 17.4.",
                url: "https://linear.app/acme/issue/ENG-42#comment-1",
                createdAt: "2026-11-21T10:00:00.000Z",
                user: { name: "Ada" },
              },
            ],
          },
        },
      },
      expect: {
        comments: [
          {
            id: "comment_1",
            body: "Reproduced on 17.4.",
            url: "https://linear.app/acme/issue/ENG-42#comment-1",
            createdAt: "2026-11-21T10:00:00.000Z",
            author: "Ada",
          },
        ],
      },
    },

    {
      name: "listLabels",
      summary: "List issue labels, with the ids labelling needs.",
      useCases: ["list labels", "what labels exist", "find a label id"],
      sideEffects: "read",
      input: { limit: { type: "int", min: 1, max: 100, default: 50, optional: true } },
      request: {
        graphql: {
          query: `query IssueLabels($first: Int) {
  issueLabels(first: $first) {
    nodes { id name color team { key } }
  }
}`,
          variables: { first: "$limit" },
        },
      },
      output: {
        type: "object",
        fields: {
          labels: {
            type: "array",
            from: "data.issueLabels.nodes",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                name: { type: "string" },
                color: { type: "string", optional: true },
                team: { type: "string", from: "team.key", optional: true },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: {
          issueLabels: {
            nodes: [{ id: "label_1", name: "bug", color: "#eb5757", team: { key: "ENG" } }],
          },
        },
      },
      expect: { labels: [{ id: "label_1", name: "bug", color: "#eb5757", team: "ENG" }] },
    },

    {
      name: "addLabelToIssue",
      summary: "Add a label to an issue.",
      useCases: ["label an issue", "tag a ticket as a bug", "add a label in linear"],
      sideEffects: "write",
      input: {
        issueId: { type: "string" },
        labelId: { type: "string", describe: "Label id from linear.listLabels." },
      },
      request: {
        graphql: {
          query: `mutation IssueAddLabel($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) {
    success
    issue { id identifier }
  }
}`,
          variables: { id: "$issueId", labelId: "$labelId" },
        },
      },
      output: {
        type: "object",
        fields: {
          success: { type: "boolean", from: "data.issueAddLabel.success" },
          identifier: { type: "string", from: "data.issueAddLabel.issue.identifier" },
        },
      },
      args: { issueId: "issue_1", labelId: "label_1" },
      sample: {
        data: { issueAddLabel: { success: true, issue: { id: "issue_1", identifier: "ENG-42" } } },
      },
      expect: { success: true, identifier: "ENG-42" },
    },

    {
      name: "linkUrlToIssue",
      summary: "Attach a URL to an issue, e.g. the pull request that fixes it.",
      useCases: [
        "link a pr to an issue",
        "attach a url to a ticket",
        "connect a github pr to linear",
        "add a link to an issue",
      ],
      sideEffects: "write",
      input: {
        issueId: { type: "string" },
        url: { type: "string", describe: "The link to attach." },
        title: { type: "string", optional: true, describe: "Shown instead of the raw URL." },
      },
      request: {
        graphql: {
          query: `mutation AttachmentLinkURL($issueId: String!, $url: String!, $title: String) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
    success
    attachment { id url title }
  }
}`,
          variables: { issueId: "$issueId", url: "$url", title: "$title" },
        },
      },
      output: {
        type: "object",
        from: "data.attachmentLinkURL.attachment",
        fields: {
          id: { type: "string" },
          url: { type: "string" },
          title: { type: "string", optional: true },
        },
      },
      args: { issueId: "issue_1", url: "https://github.com/acme/web/pull/51" },
      sample: {
        data: {
          attachmentLinkURL: {
            success: true,
            attachment: {
              id: "attachment_1",
              url: "https://github.com/acme/web/pull/51",
              title: "Fix Safari login",
            },
          },
        },
      },
      expect: {
        id: "attachment_1",
        url: "https://github.com/acme/web/pull/51",
        title: "Fix Safari login",
      },
    },

    {
      name: "archiveIssue",
      summary: "Archive an issue, taking it off the board.",
      useCases: ["archive an issue", "remove a ticket from the board", "close out an old issue"],
      sideEffects: "destructive",
      input: { issueId: { type: "string" } },
      request: {
        graphql: {
          query: `mutation IssueArchive($id: String!) {
  issueArchive(id: $id) { success }
}`,
          variables: { id: "$issueId" },
        },
      },
      output: {
        type: "object",
        fields: { success: { type: "boolean", from: "data.issueArchive.success" } },
      },
      args: { issueId: "issue_1" },
      sample: { data: { issueArchive: { success: true } } },
      expect: { success: true },
    },

    {
      name: "listCycles",
      summary: "List cycles (sprints), with their dates and progress.",
      useCases: [
        "what is in this sprint",
        "list cycles",
        "when does the cycle end",
        "sprint progress",
      ],
      keywords: ["sprint", "iteration"],
      sideEffects: "read",
      input: { limit: { type: "int", min: 1, max: 100, default: 25, optional: true } },
      request: {
        graphql: {
          query: `query Cycles($first: Int) {
  cycles(first: $first) {
    nodes { id name number startsAt endsAt progress team { key } }
  }
}`,
          variables: { first: "$limit" },
        },
      },
      output: {
        type: "object",
        fields: {
          cycles: {
            type: "array",
            from: "data.cycles.nodes",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                name: { type: "string", optional: true },
                number: { type: "number" },
                startsAt: { type: "string" },
                endsAt: { type: "string" },
                progress: { type: "number", describe: "0 to 1." },
                team: { type: "string", from: "team.key", optional: true },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        data: {
          cycles: {
            nodes: [
              {
                id: "cycle_1",
                name: "Cycle 12",
                number: 12,
                startsAt: "2026-11-17T00:00:00.000Z",
                endsAt: "2026-12-01T00:00:00.000Z",
                progress: 0.6,
                team: { key: "ENG" },
              },
            ],
          },
        },
      },
      expect: {
        cycles: [
          {
            id: "cycle_1",
            name: "Cycle 12",
            number: 12,
            startsAt: "2026-11-17T00:00:00.000Z",
            endsAt: "2026-12-01T00:00:00.000Z",
            progress: 0.6,
            team: "ENG",
          },
        ],
      },
    },

    {
      name: "me",
      summary: "Read the user the API key belongs to.",
      useCases: ["who am i in linear", "my linear user id", "what account is this key"],
      sideEffects: "read",
      input: {},
      request: {
        graphql: {
          query: `query Me {
  viewer { id name displayName email }
}`,
        },
      },
      output: {
        type: "object",
        from: "data.viewer",
        fields: {
          id: { type: "string" },
          name: { type: "string" },
          displayName: { type: "string", optional: true },
          email: { type: "string", optional: true },
        },
      },
      args: {},
      sample: {
        data: {
          viewer: {
            id: "user_1",
            name: "Ada Lovelace",
            displayName: "ada",
            email: "ada@example.com",
          },
        },
      },
      expect: {
        id: "user_1",
        name: "Ada Lovelace",
        displayName: "ada",
        email: "ada@example.com",
      },
    },
  ],
};
