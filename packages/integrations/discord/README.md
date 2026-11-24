# @cloudfarm/discord

Community chat. Post messages to a channel, read recent messages, and list a server's channels.

Generated from `tools/integration-codegen/specs/discord.mjs`. Edit the spec and run
`pnpm gen:integrations`; `src/` is overwritten, so hand edits there are lost.

## Credentials

Create an application at discord.com/developers/applications, add a bot, copy its token, and invite the bot to the server with the `View Channels`, `Send Messages` and `Read Message History` permissions. Reading history needs the bot to be in the channel; no OAuth flow is involved. See [the upstream docs](https://discord.com/developers/docs/reference).

The credential is held by the auth scheme and applied per request. No action
handler, result, or code-mode script can read it, and `allowedHosts` keeps a
credentialed request from being redirected off `discord.com` by a URL that
arrived in a model's arguments.

## Usage

```ts
import { Computer } from "@cloudfarm/core";
import { discord } from "@cloudfarm/discord";

const computer = new Computer({
  apps: [discord({ apiKey: process.env.DISCORD_API_KEY! })],
});
```

## Actions

| ref                               | what it does                                                  | effects     |
| --------------------------------- | ------------------------------------------------------------- | ----------- |
| `discord.sendMessage`             | Post a message to a channel.                                  | write       |
| `discord.listMessages`            | Read recent messages in a channel, newest first.              | read        |
| `discord.listChannels`            | List the channels in a server.                                | read        |
| `discord.getMessage`              | Read one message by id.                                       | read        |
| `discord.replyToMessage`          | Reply to a message, so Discord threads it under the original. | write       |
| `discord.editMessage`             | Edit a message the bot sent.                                  | write       |
| `discord.deleteMessage`           | Delete a message.                                             | destructive |
| `discord.addReaction`             | React to a message with an emoji.                             | write       |
| `discord.removeReaction`          | Remove the bot's own reaction from a message.                 | write       |
| `discord.listPinnedMessages`      | List a channel's pinned messages.                             | read        |
| `discord.pinMessage`              | Pin a message in a channel.                                   | write       |
| `discord.createThreadFromMessage` | Start a thread on a message.                                  | write       |
| `discord.listActiveThreads`       | List a server's active threads.                               | read        |
| `discord.getChannel`              | Read one channel's name, topic and type.                      | read        |
| `discord.createChannel`           | Create a channel in a server.                                 | write       |
| `discord.getGuild`                | Read a server's name and member count.                        | read        |
| `discord.listGuilds`              | List the servers the bot is in.                               | read        |
| `discord.listMembers`             | List a server's members.                                      | read        |
| `discord.getMember`               | Read one server member, with their roles.                     | read        |
| `discord.listRoles`               | List a server's roles.                                        | read        |
| `discord.addRoleToMember`         | Give a member a role.                                         | write       |
| `discord.removeRoleFromMember`    | Take a role away from a member.                               | write       |
| `discord.openDirectMessage`       | Open a DM channel with a user, to send them a message.        | write       |
| `discord.whoAmI`                  | Read the bot account this token belongs to.                   | read        |

Every action goes through `context.http`, so a non-2xx arrives as an `HttpError`
carrying its status: a 429 reaches the model as a retryable rate limit rather
than a permanent fault. Runs on Node **and** Workers — it uses nothing but
`fetch`.
