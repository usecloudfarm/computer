/** Discord: read and post in channels with a bot token. */
export default {
  id: "discord",
  name: "Discord",
  description:
    "Community chat. Post messages to a channel, read recent messages, and list a server's channels.",
  npmDescription: "Discord as a Computer app: post and read channel messages",
  docsUrl: "https://discord.com/developers/docs/reference",
  credentials:
    "Create an application at discord.com/developers/applications, add a bot, copy its token, and invite the bot to the server with the `View Channels`, `Send Messages` and `Read Message History` permissions. Reading history needs the bot to be in the channel; no OAuth flow is involved.",
  auth: {
    kind: "apiKey",
    // Discord's own scheme name, and not interchangeable with `Bearer`.
    prefix: "Bot",
    describe: "A Discord bot token, from the application's Bot tab.",
  },
  baseUrl: "https://discord.com/api/v10",
  allowedHosts: ["discord.com"],
  notes: [
    "The credential is a bot token, which Discord sends as `Authorization: Bot",
    "<token>` rather than `Bearer <token>` — the auth scheme's `prefix` is",
    "what makes that one line of spec instead of a hand-written header.",
    "",
    "Channel and guild ids are snowflakes: 64-bit integers that arrive as",
    "strings and must stay strings, so they are typed as strings here rather",
    "than numbers that would lose precision.",
  ],
  actions: [
    {
      name: "sendMessage",
      summary: "Post a message to a channel.",
      useCases: [
        "send a discord message",
        "post to a discord channel",
        "announce something on discord",
        "notify the community",
      ],
      keywords: ["chat", "post", "announce"],
      sideEffects: "write",
      input: {
        channelId: { type: "string", describe: "Channel snowflake id." },
        content: { type: "string", min: 1, max: 2000, describe: "Message text; markdown works." },
      },
      request: {
        method: "POST",
        path: "channels/{channelId}/messages",
        body: { content: "$content" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          channelId: { type: "string", from: "channel_id" },
          timestamp: { type: "string" },
        },
      },
      args: { channelId: "1234567890", content: "v1 is out" },
      sample: {
        id: "9999999999",
        channel_id: "1234567890",
        timestamp: "2026-11-24T08:00:00.000000+00:00",
      },
      expect: {
        id: "9999999999",
        channelId: "1234567890",
        timestamp: "2026-11-24T08:00:00.000000+00:00",
      },
    },

    {
      name: "listMessages",
      summary: "Read recent messages in a channel, newest first.",
      useCases: [
        "read a discord channel",
        "what was said in discord",
        "catch up on a channel",
        "recent discord messages",
      ],
      sideEffects: "read",
      input: {
        channelId: { type: "string" },
        limit: { type: "int", min: 1, max: 100, default: 25, optional: true },
      },
      request: {
        method: "GET",
        path: "channels/{channelId}/messages",
        query: { limit: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          messages: {
            type: "array",
            // The response is a bare JSON array.
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                content: { type: "string" },
                author: { type: "string", from: "author.username" },
                timestamp: { type: "string" },
              },
            },
          },
        },
      },
      args: { channelId: "1234567890" },
      sample: [
        {
          id: "9999999999",
          content: "v1 is out",
          author: { username: "ada" },
          timestamp: "2026-11-24T08:00:00.000000+00:00",
        },
      ],
      expect: {
        messages: [
          {
            id: "9999999999",
            content: "v1 is out",
            author: "ada",
            timestamp: "2026-11-24T08:00:00.000000+00:00",
          },
        ],
      },
    },

    {
      name: "listChannels",
      summary: "List the channels in a server.",
      useCases: [
        "list discord channels",
        "find a channel id",
        "what channels does this server have",
      ],
      sideEffects: "read",
      input: { guildId: { type: "string", describe: "Server (guild) snowflake id." } },
      request: { method: "GET", path: "guilds/{guildId}/channels" },
      output: {
        type: "object",
        fields: {
          channels: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                name: { type: "string" },
                type: { type: "number", describe: "0 is a text channel, 2 voice." },
                topic: { type: "string", optional: true },
              },
            },
          },
        },
      },
      args: { guildId: "1111111111" },
      sample: [{ id: "1234567890", name: "general", type: 0, topic: "Anything goes" }],
      expect: {
        channels: [{ id: "1234567890", name: "general", type: 0, topic: "Anything goes" }],
      },
    },
    {
      name: "getMessage",
      summary: "Read one message by id.",
      useCases: ["read a discord message", "what did that message say", "fetch a message by id"],
      sideEffects: "read",
      input: { channelId: { type: "string" }, messageId: { type: "string" } },
      request: { method: "GET", path: "channels/{channelId}/messages/{messageId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          content: { type: "string" },
          author: { type: "string", from: "author.username" },
          timestamp: { type: "string" },
          pinned: { type: "boolean", optional: true },
        },
      },
      args: { channelId: "1234567890", messageId: "9999999999" },
      sample: {
        id: "9999999999",
        content: "v1 is out",
        author: { username: "ada" },
        timestamp: "2026-11-24T08:00:00.000000+00:00",
        pinned: false,
      },
      expect: {
        id: "9999999999",
        content: "v1 is out",
        author: "ada",
        timestamp: "2026-11-24T08:00:00.000000+00:00",
        pinned: false,
      },
    },

    {
      name: "replyToMessage",
      summary: "Reply to a message, so Discord threads it under the original.",
      useCases: ["reply to a discord message", "respond in a channel", "answer someone on discord"],
      sideEffects: "write",
      input: {
        channelId: { type: "string" },
        messageId: { type: "string", describe: "Message being replied to." },
        content: { type: "string", min: 1, max: 2000 },
      },
      request: {
        method: "POST",
        path: "channels/{channelId}/messages",
        body: {
          content: "$content",
          message_reference: { message_id: "$messageId" },
        },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          channelId: { type: "string", from: "channel_id" },
        },
      },
      args: { channelId: "1234567890", messageId: "9999999999", content: "on it" },
      sample: { id: "9999999998", channel_id: "1234567890" },
      expect: { id: "9999999998", channelId: "1234567890" },
    },

    {
      name: "editMessage",
      summary: "Edit a message the bot sent.",
      useCases: ["edit a discord message", "fix a typo in a message", "update a posted message"],
      sideEffects: "write",
      input: {
        channelId: { type: "string" },
        messageId: { type: "string" },
        content: { type: "string", min: 1, max: 2000 },
      },
      request: {
        method: "PATCH",
        path: "channels/{channelId}/messages/{messageId}",
        body: { content: "$content" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          content: { type: "string" },
          editedTimestamp: { type: "string", from: "edited_timestamp", optional: true },
        },
      },
      args: { channelId: "1234567890", messageId: "9999999999", content: "v1.0.1 is out" },
      sample: {
        id: "9999999999",
        content: "v1.0.1 is out",
        edited_timestamp: "2026-11-24T08:05:00.000000+00:00",
      },
      expect: {
        id: "9999999999",
        content: "v1.0.1 is out",
        editedTimestamp: "2026-11-24T08:05:00.000000+00:00",
      },
    },

    {
      name: "deleteMessage",
      summary: "Delete a message.",
      useCases: ["delete a discord message", "remove a post", "take down a message"],
      sideEffects: "destructive",
      input: { channelId: { type: "string" }, messageId: { type: "string" } },
      request: { method: "DELETE", path: "channels/{channelId}/messages/{messageId}" },
      // Discord answers 204 with no body.
      output: { type: "object", fields: {} },
      args: { channelId: "1234567890", messageId: "9999999999" },
      sample: {},
      expect: {},
    },

    {
      name: "addReaction",
      summary: "React to a message with an emoji.",
      useCases: ["react to a message", "add an emoji reaction", "thumbs up a discord message"],
      sideEffects: "write",
      input: {
        channelId: { type: "string" },
        messageId: { type: "string" },
        emoji: {
          type: "string",
          describe: 'A unicode emoji like "👍", or "name:id" for a custom one.',
        },
      },
      request: {
        method: "PUT",
        path: "channels/{channelId}/messages/{messageId}/reactions/{emoji}/@me",
      },
      output: { type: "object", fields: {} },
      args: { channelId: "1234567890", messageId: "9999999999", emoji: "👍" },
      sample: {},
      expect: {},
    },

    {
      name: "removeReaction",
      summary: "Remove the bot's own reaction from a message.",
      useCases: ["remove a reaction", "undo an emoji reaction"],
      sideEffects: "write",
      input: {
        channelId: { type: "string" },
        messageId: { type: "string" },
        emoji: { type: "string" },
      },
      request: {
        method: "DELETE",
        path: "channels/{channelId}/messages/{messageId}/reactions/{emoji}/@me",
      },
      output: { type: "object", fields: {} },
      args: { channelId: "1234567890", messageId: "9999999999", emoji: "👍" },
      sample: {},
      expect: {},
    },

    {
      name: "listPinnedMessages",
      summary: "List a channel's pinned messages.",
      useCases: ["what is pinned in this channel", "list pinned messages", "find the pinned notes"],
      sideEffects: "read",
      input: { channelId: { type: "string" } },
      request: { method: "GET", path: "channels/{channelId}/messages/pins" },
      output: {
        type: "object",
        fields: {
          messages: {
            type: "array",
            from: "items",
            item: {
              type: "object",
              fields: {
                id: { type: "string", from: "message.id" },
                content: { type: "string", from: "message.content" },
                author: { type: "string", from: "message.author.username" },
                pinnedAt: { type: "string", from: "pinned_at", optional: true },
              },
            },
          },
        },
      },
      args: { channelId: "1234567890" },
      sample: {
        items: [
          {
            pinned_at: "2026-11-20T09:00:00.000000+00:00",
            message: { id: "9999999997", content: "Read this first", author: { username: "ada" } },
          },
        ],
      },
      expect: {
        messages: [
          {
            id: "9999999997",
            content: "Read this first",
            author: "ada",
            pinnedAt: "2026-11-20T09:00:00.000000+00:00",
          },
        ],
      },
    },

    {
      name: "pinMessage",
      summary: "Pin a message in a channel.",
      useCases: ["pin a discord message", "pin this to the channel"],
      sideEffects: "write",
      input: { channelId: { type: "string" }, messageId: { type: "string" } },
      request: { method: "PUT", path: "channels/{channelId}/messages/pins/{messageId}" },
      output: { type: "object", fields: {} },
      args: { channelId: "1234567890", messageId: "9999999999" },
      sample: {},
      expect: {},
    },

    {
      name: "createThreadFromMessage",
      summary: "Start a thread on a message.",
      useCases: [
        "start a thread on this message",
        "create a discord thread",
        "branch a conversation",
      ],
      sideEffects: "write",
      input: {
        channelId: { type: "string" },
        messageId: { type: "string" },
        name: { type: "string", min: 1, max: 100, describe: "Thread title." },
      },
      request: {
        method: "POST",
        path: "channels/{channelId}/messages/{messageId}/threads",
        body: { name: "$name" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          name: { type: "string" },
          parentId: { type: "string", from: "parent_id", optional: true },
        },
      },
      args: { channelId: "1234567890", messageId: "9999999999", name: "Safari bug" },
      sample: { id: "1234567891", name: "Safari bug", parent_id: "1234567890" },
      expect: { id: "1234567891", name: "Safari bug", parentId: "1234567890" },
    },

    {
      name: "listActiveThreads",
      summary: "List a server's active threads.",
      useCases: [
        "what threads are active",
        "list discord threads",
        "open conversations in this server",
      ],
      sideEffects: "read",
      input: { guildId: { type: "string", describe: "Server (guild) snowflake id." } },
      request: { method: "GET", path: "guilds/{guildId}/threads/active" },
      output: {
        type: "object",
        fields: {
          threads: {
            type: "array",
            from: "threads",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                name: { type: "string" },
                parentId: { type: "string", from: "parent_id", optional: true },
                messageCount: { type: "number", from: "message_count", optional: true },
              },
            },
          },
        },
      },
      args: { guildId: "1111111111" },
      sample: {
        threads: [
          { id: "1234567891", name: "Safari bug", parent_id: "1234567890", message_count: 4 },
        ],
      },
      expect: {
        threads: [
          { id: "1234567891", name: "Safari bug", parentId: "1234567890", messageCount: 4 },
        ],
      },
    },

    {
      name: "getChannel",
      summary: "Read one channel's name, topic and type.",
      useCases: ["read a discord channel", "what is this channel for", "channel details"],
      sideEffects: "read",
      input: { channelId: { type: "string" } },
      request: { method: "GET", path: "channels/{channelId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          name: { type: "string", optional: true },
          type: { type: "number" },
          topic: { type: "string", optional: true },
          guildId: { type: "string", from: "guild_id", optional: true },
        },
      },
      args: { channelId: "1234567890" },
      sample: {
        id: "1234567890",
        name: "general",
        type: 0,
        topic: "Anything goes",
        guild_id: "1111111111",
      },
      expect: {
        id: "1234567890",
        name: "general",
        type: 0,
        topic: "Anything goes",
        guildId: "1111111111",
      },
    },

    {
      name: "createChannel",
      summary: "Create a channel in a server.",
      useCases: [
        "create a discord channel",
        "add a channel to the server",
        "make a new text channel",
      ],
      sideEffects: "write",
      input: {
        guildId: { type: "string" },
        name: { type: "string", min: 1, max: 100 },
        type: {
          type: "int",
          default: 0,
          optional: true,
          describe: "0 text, 2 voice, 4 category, 15 forum.",
        },
        topic: { type: "string", optional: true },
        parentId: { type: "string", optional: true, describe: "Category to create it under." },
      },
      request: {
        method: "POST",
        path: "guilds/{guildId}/channels",
        body: { name: "$name", type: "$type", topic: "$topic", parent_id: "$parentId" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          name: { type: "string", optional: true },
          type: { type: "number" },
        },
      },
      args: { guildId: "1111111111", name: "release-notes" },
      sample: { id: "1234567892", name: "release-notes", type: 0 },
      expect: { id: "1234567892", name: "release-notes", type: 0 },
    },

    {
      name: "getGuild",
      summary: "Read a server's name and member count.",
      useCases: [
        "read a discord server",
        "how many members does this server have",
        "guild details",
      ],
      sideEffects: "read",
      input: { guildId: { type: "string" } },
      request: { method: "GET", path: "guilds/{guildId}", query: { with_counts: true } },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string", optional: true },
          memberCount: { type: "number", from: "approximate_member_count", optional: true },
        },
      },
      args: { guildId: "1111111111" },
      sample: {
        id: "1111111111",
        name: "Acme",
        description: "The Acme community",
        approximate_member_count: 4200,
      },
      expect: {
        id: "1111111111",
        name: "Acme",
        description: "The Acme community",
        memberCount: 4200,
      },
    },

    {
      name: "listGuilds",
      summary: "List the servers the bot is in.",
      useCases: ["what servers is the bot in", "list discord guilds", "find a server id"],
      sideEffects: "read",
      input: {},
      request: { method: "GET", path: "users/@me/guilds" },
      output: {
        type: "object",
        fields: {
          guilds: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: { id: { type: "string" }, name: { type: "string" } },
            },
          },
        },
      },
      args: {},
      sample: [{ id: "1111111111", name: "Acme" }],
      expect: { guilds: [{ id: "1111111111", name: "Acme" }] },
    },

    {
      name: "listMembers",
      summary: "List a server's members.",
      useCases: ["who is in this server", "list discord members", "find a user id"],
      sideEffects: "read",
      input: {
        guildId: { type: "string" },
        limit: { type: "int", min: 1, max: 1000, default: 50, optional: true },
      },
      request: {
        method: "GET",
        path: "guilds/{guildId}/members",
        query: { limit: "$limit" },
      },
      output: {
        type: "object",
        fields: {
          members: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "string", from: "user.id" },
                username: { type: "string", from: "user.username" },
                nick: { type: "string", optional: true },
                joinedAt: { type: "string", from: "joined_at", optional: true },
              },
            },
          },
        },
      },
      args: { guildId: "1111111111" },
      sample: [
        {
          user: { id: "2222222222", username: "ada" },
          nick: "Ada",
          joined_at: "2026-01-02T00:00:00.000000+00:00",
        },
      ],
      expect: {
        members: [
          {
            id: "2222222222",
            username: "ada",
            nick: "Ada",
            joinedAt: "2026-01-02T00:00:00.000000+00:00",
          },
        ],
      },
    },

    {
      name: "getMember",
      summary: "Read one server member, with their roles.",
      useCases: ["what roles does this member have", "read a discord member", "member details"],
      sideEffects: "read",
      input: { guildId: { type: "string" }, userId: { type: "string" } },
      request: { method: "GET", path: "guilds/{guildId}/members/{userId}" },
      output: {
        type: "object",
        fields: {
          id: { type: "string", from: "user.id" },
          username: { type: "string", from: "user.username" },
          nick: { type: "string", optional: true },
          roles: { type: "array", item: { type: "string" } },
        },
      },
      args: { guildId: "1111111111", userId: "2222222222" },
      sample: {
        user: { id: "2222222222", username: "ada" },
        nick: "Ada",
        roles: ["3333333333"],
      },
      expect: { id: "2222222222", username: "ada", nick: "Ada", roles: ["3333333333"] },
    },

    {
      name: "listRoles",
      summary: "List a server's roles.",
      useCases: ["list discord roles", "what roles exist", "find a role id"],
      sideEffects: "read",
      input: { guildId: { type: "string" } },
      request: { method: "GET", path: "guilds/{guildId}/roles" },
      output: {
        type: "object",
        fields: {
          roles: {
            type: "array",
            from: "",
            item: {
              type: "object",
              fields: {
                id: { type: "string" },
                name: { type: "string" },
                position: { type: "number", optional: true },
                managed: { type: "boolean", optional: true },
              },
            },
          },
        },
      },
      args: { guildId: "1111111111" },
      sample: [{ id: "3333333333", name: "Contributors", position: 2, managed: false }],
      expect: {
        roles: [{ id: "3333333333", name: "Contributors", position: 2, managed: false }],
      },
    },

    {
      name: "addRoleToMember",
      summary: "Give a member a role.",
      useCases: ["give someone a role", "add a discord role to a member", "promote a member"],
      sideEffects: "write",
      input: {
        guildId: { type: "string" },
        userId: { type: "string" },
        roleId: { type: "string", describe: "Role id from discord.listRoles." },
      },
      request: { method: "PUT", path: "guilds/{guildId}/members/{userId}/roles/{roleId}" },
      output: { type: "object", fields: {} },
      args: { guildId: "1111111111", userId: "2222222222", roleId: "3333333333" },
      sample: {},
      expect: {},
    },

    {
      name: "removeRoleFromMember",
      summary: "Take a role away from a member.",
      useCases: ["remove a discord role", "take a role off someone"],
      sideEffects: "write",
      input: {
        guildId: { type: "string" },
        userId: { type: "string" },
        roleId: { type: "string" },
      },
      request: { method: "DELETE", path: "guilds/{guildId}/members/{userId}/roles/{roleId}" },
      output: { type: "object", fields: {} },
      args: { guildId: "1111111111", userId: "2222222222", roleId: "3333333333" },
      sample: {},
      expect: {},
    },

    {
      name: "openDirectMessage",
      summary: "Open a DM channel with a user, to send them a message.",
      useCases: ["dm someone on discord", "send a direct message", "message a user privately"],
      sideEffects: "write",
      input: { userId: { type: "string", describe: "Recipient's user id." } },
      request: {
        method: "POST",
        path: "users/@me/channels",
        body: { recipient_id: "$userId" },
      },
      output: {
        type: "object",
        fields: {
          id: { type: "string", describe: "Channel id; pass it to discord.sendMessage." },
          type: { type: "number" },
        },
      },
      args: { userId: "2222222222" },
      sample: { id: "4444444444", type: 1 },
      expect: { id: "4444444444", type: 1 },
    },

    {
      name: "whoAmI",
      summary: "Read the bot account this token belongs to.",
      useCases: ["who is this bot", "what account is this discord token", "bot identity"],
      sideEffects: "read",
      input: {},
      request: { method: "GET", path: "users/@me" },
      output: {
        type: "object",
        fields: {
          id: { type: "string" },
          username: { type: "string" },
          bot: { type: "boolean", optional: true },
        },
      },
      args: {},
      sample: { id: "5555555555", username: "acmebot", bot: true },
      expect: { id: "5555555555", username: "acmebot", bot: true },
    },
  ],
};
