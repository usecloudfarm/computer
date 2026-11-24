---
title: Discord
description: Community chat. Post messages to a channel, read recent messages, and list a server's channels.
app:
  package: "@cloudfarm/discord"
  icon: "https://cdn.simpleicons.org/discord"
  credential: api-key
  mark: Di
---

## Install

```bash
pnpm add @cloudfarm/discord
```

## Connect

```ts
import { discord } from "@cloudfarm/discord";

const computer = new Computer({
  apps: [
    discord({
      apiKey: process.env.DISCORD_API_KEY,
    }),
  ],
});
```

Create an application at discord.com/developers/applications, add a bot, copy its token, and invite the bot to the server with the `View Channels`, `Send Messages` and `Read Message History` permissions. Reading history needs the bot to be in the channel; no OAuth flow is involved.

| Option   | Type     | Notes                                                          |
| -------- | -------- | -------------------------------------------------------------- |
| `apiKey` | `string` | Required. A Discord bot token, from the application's Bot tab. |

Requests may only reach `discord.com`.

## What the agent can do

| Action                            | Does                                                         | Writes |
| --------------------------------- | ------------------------------------------------------------ | ------ |
| `discord.sendMessage`             | Post a message to a channel                                  | yes    |
| `discord.listMessages`            | Read recent messages in a channel, newest first              | no     |
| `discord.listChannels`            | List the channels in a server                                | no     |
| `discord.getMessage`              | Read one message by id                                       | no     |
| `discord.replyToMessage`          | Reply to a message, so Discord threads it under the original | yes    |
| `discord.editMessage`             | Edit a message the bot sent                                  | yes    |
| `discord.deleteMessage`           | Delete a message                                             | yes    |
| `discord.addReaction`             | React to a message with an emoji                             | yes    |
| `discord.removeReaction`          | Remove the bot's own reaction from a message                 | yes    |
| `discord.listPinnedMessages`      | List a channel's pinned messages                             | no     |
| `discord.pinMessage`              | Pin a message in a channel                                   | yes    |
| `discord.createThreadFromMessage` | Start a thread on a message                                  | yes    |
| `discord.listActiveThreads`       | List a server's active threads                               | no     |
| `discord.getChannel`              | Read one channel's name, topic and type                      | no     |
| `discord.createChannel`           | Create a channel in a server                                 | yes    |
| `discord.getGuild`                | Read a server's name and member count                        | no     |
| `discord.listGuilds`              | List the servers the bot is in                               | no     |
| `discord.listMembers`             | List a server's members                                      | no     |
| `discord.getMember`               | Read one server member, with their roles                     | no     |
| `discord.listRoles`               | List a server's roles                                        | no     |
| `discord.addRoleToMember`         | Give a member a role                                         | yes    |
| `discord.removeRoleFromMember`    | Take a role away from a member                               | yes    |
| `discord.openDirectMessage`       | Open a DM channel with a user, to send them a message        | yes    |
| `discord.whoAmI`                  | Read the bot account this token belongs to                   | no     |

```ts
run({ ref: "discord.listMessages", args: { channelId: "…" } });
run({ ref: "discord.sendMessage", args: { channelId: "…", content: "…" } });
```

## Notes

The credential is a bot token, which Discord sends as `Authorization: Bot
<token>` rather than `Bearer <token>` — the auth scheme's `prefix` is
what makes that one line of spec instead of a hand-written header.

Channel and guild ids are snowflakes: 64-bit integers that arrive as
strings and must stay strings, so they are typed as strings here rather
than numbers that would lose precision.

Upstream API docs: <https://discord.com/developers/docs/reference>
