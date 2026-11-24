/** Notion: search, read and write pages with an internal integration token. */
export default {
  id: "notion",
  name: "Notion",
  description:
    "Notes and docs. Search the workspace, read a page, create pages, append paragraphs, and query a database.",
  npmDescription: "Notion as a Computer app: search, read, create and append to pages",
  icon: "https://cdn.simpleicons.org/notion",
  docsUrl: "https://developers.notion.com/reference/intro",
  credentials:
    "Create an internal integration at notion.so/my-integrations and copy its secret, then share the pages or databases it should reach with that integration — Notion grants nothing by default, so an unshared page is invisible even with a valid token.",
  auth: { kind: "apiKey", describe: "A Notion internal integration token (ntn_… or secret_…)." },
  baseUrl: "https://api.notion.com/v1",
  allowedHosts: ["api.notion.com"],
  headers: {
    // Notion versions its API by header, and omitting it is an error rather
    // than a default. Pinning it here is what keeps a response shape stable.
    "Notion-Version": "2022-06-28",
  },
  notes: [
    "An internal integration token is a plain string, so no OAuth flow is",
    "involved — but access is per page: an agent sees only what the",
    "integration has been shared with. That is a better default than a key",
    "that reads everything, and it is worth saying in the credential prose",
    "because an empty search result is otherwise baffling.",
    "",
    "Titles live at different property names across databases, so `search`",
    "reads the conventional `title` property and the row mapping hands back",
    "`properties` untouched for anything else a model needs.",
  ],
  actions: [
    {
      name: "search",
      summary: "Search pages and databases the integration can see.",
      useCases: [
        "search notion",
        "find a page",
        "where are the meeting notes",
        "look up a doc",
        "find the roadmap page",
      ],
      keywords: ["doc", "wiki", "notes"],
      sideEffects: "read",
      input: {
        query: { type: "string", describe: "Matches page and database titles." },
        limit: { type: "int", min: 1, max: 100, default: 20, optional: true },
      },
      request: { method: "POST", path: "search", body: { query: "$query", page_size: "$limit" } },
      output: {
        type: "object",
        fields: {
          results: {
            type: "array",
            from: "results",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                object: { type: "string", describe: '"page" or "database".' },
                url: { type: "string", optional: true },
                title: {
                  type: "string",
                  from: "properties.title.title.0.plain_text",
                  optional: true,
                },
                lastEditedTime: { type: "string", from: "last_edited_time", optional: true },
              },
            },
          },
        },
      },
      args: { query: "roadmap" },
      sample: {
        results: [
          {
            object: "page",
            id: "page_1",
            url: "https://notion.so/page_1",
            last_edited_time: "2026-11-20T09:00:00.000Z",
            properties: { title: { title: [{ plain_text: "Roadmap" }] } },
          },
        ],
      },
      expect: {
        results: [
          {
            id: "page_1",
            object: "page",
            url: "https://notion.so/page_1",
            title: "Roadmap",
            lastEditedTime: "2026-11-20T09:00:00.000Z",
          },
        ],
      },
    },

    {
      name: "getPage",
      summary: "Read a page's metadata and properties.",
      useCases: ["read a notion page", "get page properties", "open a page by id"],
      sideEffects: "read",
      input: { pageId: { type: "string", describe: "Page id, with or without dashes." } },
      request: { method: "GET", path: "pages/{pageId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          url: { type: "string" },
          archived: { type: "boolean" },
          createdTime: { type: "string", from: "created_time" },
          lastEditedTime: { type: "string", from: "last_edited_time" },
          properties: { type: "json", describe: "Raw Notion property values." },
        },
      },
      args: { pageId: "page_1" },
      sample: {
        id: "page_1",
        url: "https://notion.so/page_1",
        archived: false,
        created_time: "2026-11-01T09:00:00.000Z",
        last_edited_time: "2026-11-20T09:00:00.000Z",
        properties: { title: { title: [{ plain_text: "Roadmap" }] } },
      },
      expect: {
        id: "page_1",
        url: "https://notion.so/page_1",
        archived: false,
        createdTime: "2026-11-01T09:00:00.000Z",
        lastEditedTime: "2026-11-20T09:00:00.000Z",
        properties: { title: { title: [{ plain_text: "Roadmap" }] } },
      },
    },

    {
      name: "createPage",
      summary: "Create a page under an existing page.",
      useCases: ["create a notion page", "add a page", "write up notes in notion", "start a doc"],
      sideEffects: "write",
      input: {
        parentPageId: { type: "string", describe: "Page the new page is created under." },
        title: { type: "string", min: 1 },
      },
      request: {
        method: "POST",
        path: "pages",
        body: {
          parent: { page_id: "$parentPageId" },
          properties: { title: { title: [{ text: { content: "$title" } }] } },
        },
      },
      output: {
        type: "object",
        fields: { id: { type: "string" }, url: { type: "string" } },
      },
      args: { parentPageId: "page_1", title: "Week 48 notes" },
      sample: { id: "page_2", url: "https://notion.so/page_2" },
      expect: { id: "page_2", url: "https://notion.so/page_2" },
    },

    {
      name: "appendParagraph",
      summary: "Append a paragraph of text to a page.",
      useCases: [
        "append to a notion page",
        "add a note to a page",
        "write a line into notion",
        "log something to a page",
      ],
      sideEffects: "write",
      input: {
        blockId: { type: "string", describe: "Page id, or the id of a block to append inside." },
        text: { type: "string", min: 1 },
      },
      request: {
        method: "PATCH",
        path: "blocks/{blockId}/children",
        body: {
          children: [
            {
              object: "block",
              type: "paragraph",
              paragraph: { rich_text: [{ type: "text", text: { content: "$text" } }] },
            },
          ],
        },
      },
      output: {
        type: "object",
        fields: {
          blocks: {
            type: "array",
            from: "results",
            item: {
              type: "object",
              fields: { id: { type: "string" }, type: { type: "string" } },
            },
          },
        },
      },
      args: { blockId: "page_1", text: "Shipped the Safari fix." },
      sample: { results: [{ id: "block_1", type: "paragraph" }] },
      expect: { blocks: [{ id: "block_1", type: "paragraph" }] },
    },

    {
      name: "queryDatabase",
      summary: "List rows in a database.",
      useCases: [
        "query a notion database",
        "list rows in a notion table",
        "read the tasks database",
        "what is in this notion table",
      ],
      sideEffects: "read",
      input: {
        databaseId: { type: "string" },
        limit: { type: "int", min: 1, max: 100, default: 25, optional: true },
      },
      request: {
        method: "POST",
        path: "databases/{databaseId}/query",
        body: { page_size: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          rows: {
            type: "array",
            from: "results",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                url: { type: "string", optional: true },
                properties: { type: "json" },
              },
            },
          },
        },
      },
      args: { databaseId: "db_1" },
      sample: {
        results: [
          {
            id: "row_1",
            url: "https://notion.so/row_1",
            properties: { Name: { title: [{ plain_text: "Ship login fix" }] } },
          },
        ],
      },
      expect: {
        rows: [
          {
            id: "row_1",
            url: "https://notion.so/row_1",
            properties: { Name: { title: [{ plain_text: "Ship login fix" }] } },
          },
        ],
      },
    },
    {
      name: "getBlockChildren",
      summary: "Read a page's content blocks, in order.",
      useCases: [
        "read a notion page's content",
        "what does this page say",
        "get the text of a page",
        "read the blocks on a page",
      ],
      keywords: ["content", "body", "text"],
      sideEffects: "read",
      input: {
        blockId: { type: "string", describe: "Page id, or a block id to read inside." },
        limit: { type: "int", min: 1, max: 100, default: 50, optional: true },
      },
      request: {
        method: "GET",
        path: "blocks/{blockId}/children",
        query: { page_size: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          blocks: {
            type: "array",
            from: "results",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                type: { type: "string", describe: "paragraph, heading_1, bulleted_list_item, …" },
                hasChildren: { type: "boolean", from: "has_children" },
                text: {
                  type: "string",
                  from: "paragraph.rich_text.0.plain_text",
                  optional: true,
                  describe: "Plain text of a paragraph; other block types carry theirs in `block`.",
                },
                block: { type: "json", from: "", describe: "The raw block, whatever its type." },
              },
            },
          },
          hasMore: { type: "boolean", from: "has_more", optional: true },
        },
      },
      args: { blockId: "page_1" },
      sample: {
        results: [
          {
            id: "block_1",
            type: "paragraph",
            has_children: false,
            paragraph: { rich_text: [{ plain_text: "Shipped the Safari fix." }] },
          },
        ],
        has_more: false,
      },
      expect: {
        blocks: [
          {
            id: "block_1",
            type: "paragraph",
            hasChildren: false,
            text: "Shipped the Safari fix.",
            block: {
              id: "block_1",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "Shipped the Safari fix." }] },
            },
          },
        ],
        hasMore: false,
      },
    },

    {
      name: "appendBlocks",
      summary: "Append arbitrary Notion blocks to a page.",
      useCases: [
        "add a heading to a notion page",
        "append a bulleted list",
        "write structured content into notion",
        "add a code block to a page",
      ],
      sideEffects: "write",
      input: {
        blockId: { type: "string", describe: "Page id, or a block id to append inside." },
        children: {
          type: "json",
          describe:
            'Array of Notion block objects, e.g. [{ object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "Notes" } }] } }].',
        },
      },
      request: {
        method: "PATCH",
        path: "blocks/{blockId}/children",
        body: { children: "$children" },
      },
      output: {
        type: "object",
        fields: {
          blocks: {
            type: "array",
            from: "results",
            item: {
              type: "object",
              fields: { id: { type: "string" }, type: { type: "string" } },
            },
          },
        },
      },
      args: {
        blockId: "page_1",
        children: [
          {
            object: "block",
            type: "heading_2",
            heading_2: { rich_text: [{ text: { content: "Notes" } }] },
          },
        ],
      },
      sample: { results: [{ id: "block_2", type: "heading_2" }] },
      expect: { blocks: [{ id: "block_2", type: "heading_2" }] },
    },

    {
      name: "getBlock",
      summary: "Read one block.",
      useCases: ["read a notion block", "what type is this block"],
      sideEffects: "read",
      input: { blockId: { type: "string" } },
      request: { method: "GET", path: "blocks/{blockId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          type: { type: "string" },
          hasChildren: { type: "boolean", from: "has_children" },
          archived: { type: "boolean", optional: true },
          block: { type: "json", from: "" },
        },
      },
      args: { blockId: "block_1" },
      sample: {
        id: "block_1",
        type: "paragraph",
        has_children: false,
        archived: false,
        paragraph: { rich_text: [{ plain_text: "Shipped the Safari fix." }] },
      },
      expect: {
        id: "block_1",
        type: "paragraph",
        hasChildren: false,
        archived: false,
        block: {
          id: "block_1",
          type: "paragraph",
          has_children: false,
          archived: false,
          paragraph: { rich_text: [{ plain_text: "Shipped the Safari fix." }] },
        },
      },
    },

    {
      name: "updateParagraph",
      summary: "Replace the text of a paragraph block.",
      useCases: ["edit a notion paragraph", "fix the text on a page", "rewrite a block"],
      sideEffects: "write",
      input: {
        blockId: { type: "string", describe: "Must be a paragraph block." },
        text: { type: "string", min: 1 },
      },
      request: {
        method: "PATCH",
        path: "blocks/{blockId}",
        body: { paragraph: { rich_text: [{ type: "text", text: { content: "$text" } }] } },
      },
      output: {
        type: "object",
        fields: { id: { type: "string" }, type: { type: "string" } },
      },
      args: { blockId: "block_1", text: "Shipped the Safari fix on 17.4." },
      sample: { id: "block_1", type: "paragraph" },
      expect: { id: "block_1", type: "paragraph" },
    },

    {
      name: "deleteBlock",
      summary: "Delete a block, moving it to the trash.",
      useCases: ["delete a notion block", "remove a paragraph from a page", "clear a block"],
      sideEffects: "destructive",
      input: { blockId: { type: "string" } },
      request: { method: "DELETE", path: "blocks/{blockId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          archived: { type: "boolean", optional: true },
        },
      },
      args: { blockId: "block_1" },
      sample: { id: "block_1", archived: true },
      expect: { id: "block_1", archived: true },
    },

    {
      name: "updatePageProperties",
      summary: "Set properties on a page, such as a database row's fields.",
      useCases: [
        "update a notion page property",
        "set a status in a notion database",
        "change a row's fields",
        "mark a notion task done",
      ],
      sideEffects: "write",
      input: {
        pageId: { type: "string" },
        properties: {
          type: "json",
          describe:
            'Notion property values keyed by name, e.g. { Status: { select: { name: "Done" } } }.',
        },
      },
      request: {
        method: "PATCH",
        path: "pages/{pageId}",
        body: { properties: "$properties" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          url: { type: "string" },
          lastEditedTime: { type: "string", from: "last_edited_time", optional: true },
        },
      },
      args: { pageId: "page_1", properties: { Status: { select: { name: "Done" } } } },
      sample: {
        id: "page_1",
        url: "https://notion.so/page_1",
        last_edited_time: "2026-11-24T09:00:00.000Z",
      },
      expect: {
        id: "page_1",
        url: "https://notion.so/page_1",
        lastEditedTime: "2026-11-24T09:00:00.000Z",
      },
    },

    {
      name: "archivePage",
      summary: "Archive a page, moving it to the trash.",
      useCases: ["archive a notion page", "delete a page", "trash a notion doc"],
      sideEffects: "destructive",
      input: { pageId: { type: "string" } },
      request: { method: "PATCH", path: "pages/{pageId}", body: { archived: true } },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          archived: { type: "boolean", optional: true },
        },
      },
      args: { pageId: "page_1" },
      sample: { id: "page_1", archived: true },
      expect: { id: "page_1", archived: true },
    },

    {
      name: "listComments",
      summary: "Read the comments on a page or block.",
      useCases: ["read notion comments", "what feedback is on this page", "comments on a doc"],
      sideEffects: "read",
      input: {
        blockId: { type: "string", describe: "Page id or block id." },
        limit: { type: "int", min: 1, max: 100, default: 50, optional: true },
      },
      request: {
        method: "GET",
        path: "comments",
        query: { block_id: "$blockId", page_size: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          comments: {
            type: "array",
            from: "results",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                text: { type: "string", from: "rich_text.0.plain_text", optional: true },
                author: { type: "string", from: "created_by.id", optional: true },
                createdTime: { type: "string", from: "created_time", optional: true },
              },
            },
          },
        },
      },
      args: { blockId: "page_1" },
      sample: {
        results: [
          {
            id: "comment_1",
            rich_text: [{ plain_text: "Looks good to me." }],
            created_by: { id: "user_1" },
            created_time: "2026-11-22T09:00:00.000Z",
          },
        ],
      },
      expect: {
        comments: [
          {
            id: "comment_1",
            text: "Looks good to me.",
            author: "user_1",
            createdTime: "2026-11-22T09:00:00.000Z",
          },
        ],
      },
    },

    {
      name: "createComment",
      summary: "Comment on a page.",
      useCases: ["comment on a notion page", "leave feedback on a doc", "add a note for someone"],
      sideEffects: "write",
      input: {
        pageId: { type: "string" },
        text: { type: "string", min: 1 },
      },
      request: {
        method: "POST",
        path: "comments",
        body: {
          parent: { page_id: "$pageId" },
          rich_text: [{ type: "text", text: { content: "$text" } }],
        },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          createdTime: { type: "string", from: "created_time", optional: true },
        },
      },
      args: { pageId: "page_1", text: "Looks good to me." },
      sample: { id: "comment_2", created_time: "2026-11-24T09:00:00.000Z" },
      expect: { id: "comment_2", createdTime: "2026-11-24T09:00:00.000Z" },
    },

    {
      name: "getDatabase",
      summary: "Read a database's title and its property schema.",
      useCases: [
        "what columns does this notion database have",
        "read a notion database schema",
        "database properties",
      ],
      sideEffects: "read",
      input: { databaseId: { type: "string" } },
      request: { method: "GET", path: "databases/{databaseId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          title: { type: "string", from: "title.0.plain_text", optional: true },
          url: { type: "string", optional: true },
          properties: { type: "json", describe: "Column definitions, keyed by name." },
        },
      },
      args: { databaseId: "db_1" },
      sample: {
        id: "db_1",
        title: [{ plain_text: "Tasks" }],
        url: "https://notion.so/db_1",
        properties: { Name: { type: "title" }, Status: { type: "select" } },
      },
      expect: {
        id: "db_1",
        title: "Tasks",
        url: "https://notion.so/db_1",
        properties: { Name: { type: "title" }, Status: { type: "select" } },
      },
    },

    {
      name: "listUsers",
      summary: "List the workspace's users.",
      useCases: ["who is in this notion workspace", "list notion users", "find a notion user id"],
      sideEffects: "read",
      input: { limit: { type: "int", min: 1, max: 100, default: 50, optional: true } },
      request: { method: "GET", path: "users", query: { page_size: "$limit" } },
      output: {
        type: "object",
        fields: {
          users: {
            type: "array",
            from: "results",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                name: { type: "string", optional: true },
                type: { type: "string", optional: true, describe: '"person" or "bot".' },
                email: { type: "string", from: "person.email", optional: true },
              },
            },
          },
        },
      },
      args: {},
      sample: {
        results: [
          { id: "user_1", name: "Ada", type: "person", person: { email: "ada@example.com" } },
        ],
      },
      expect: {
        users: [{ id: "user_1", name: "Ada", type: "person", email: "ada@example.com" }],
      },
    },

    {
      name: "whoAmI",
      summary: "Read the integration this token belongs to.",
      useCases: ["what integration is this", "who am i in notion", "check the notion token"],
      sideEffects: "read",
      input: {},
      request: { method: "GET", path: "users/me" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          name: { type: "string", optional: true },
          type: { type: "string", optional: true },
        },
      },
      args: {},
      sample: { id: "bot_1", name: "Cloudfarm", type: "bot" },
      expect: { id: "bot_1", name: "Cloudfarm", type: "bot" },
    },
  ],
};
