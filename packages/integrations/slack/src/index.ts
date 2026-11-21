import { z } from "zod";
import { apiKey, createAction, createApp, UpstreamRejectedError } from "@cloudfarm/core";
import type { App, HttpConfig } from "@cloudfarm/core";

const BASE = "https://slack.com/api";

/**
 * Slack as an app plugin.
 *
 * The `apiKey` scheme defines what a developer passes — `slack({ apiKey })` —
 * and signs every request with it. The token is never a value an action
 * handler, a result, or code mode can reach: only the scheme sees it.
 *
 * Every action declares its own Zod schemas, which do four jobs at once:
 * they validate the model's arguments before anything runs, they type the
 * handler, they generate the JSON Schema a tool definition needs, and they
 * render the TypeScript the model writes against in code mode.
 */
export const slack = createApp({
  id: "slack",
  name: "Slack",
  description:
    "Team messaging. Post messages to channels or DMs, list channels, read threads and search history.",
  auth: apiKey({ describe: "A Slack bot or user token (xoxb-…)." }),
  options: z.object({
    /**
     * Override the API base, for a proxy or a test double. Its host joins the
     * egress allowlist automatically — overriding the base is an explicit act
     * by the host application, unlike a URL arriving in a model's arguments.
     */
    baseUrl: z.string().url().optional(),
  }),
  /** A prompt-injected URL cannot redirect a credentialed request off this list. */
  allowedHosts: () => ["slack.com", "*.slack.com"],
  http: ({ baseUrl }) => ({
    baseUrl: baseUrl ?? BASE,
    /**
     * Slack answers 200 with `{ ok: false, error }` rather than an HTTP
     * error, so the body is the only reliable signal. Everything else —
     * status codes, JSON encoding, query strings — core already handles.
     */
    validate: (body: unknown) => {
      const payload = body as Record<string, unknown>;
      if (payload["ok"] !== true) {
        const reason = String(payload["error"] ?? "unknown_error");
        // `ratelimited` is Slack's own word for it; mark it retryable so the
        // model is told to wait rather than to give up.
        throw new UpstreamRejectedError(
          `Slack rejected the request: ${reason}`,
          reason === "ratelimited",
        );
      }
    },
  }),
  actions: {
    sendMessage: createAction({
      summary: "Post a message to a channel or DM.",
      useCases: [
        "send a message",
        "notify a channel",
        "post an update",
        "DM a teammate",
        "tell the team something",
        "announce a release",
      ],
      keywords: ["chat", "post", "notify"],
      sideEffects: "write",
      input: z.object({
        channel: z.string().describe('Channel name ("#general"), channel id, or user id for a DM.'),
        text: z.string().describe("Message text. Slack mrkdwn is supported."),
        threadTs: z.string().optional().describe("Reply inside an existing thread."),
      }),
      output: z.object({ ts: z.string(), channel: z.string() }),
      example: '{ channel: "#general", text: "deploy finished" }',
      handler: async ({ channel, text, threadTs }, context) => {
        const body = await context.http.post("chat.postMessage", {
          channel,
          text,
          ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
        });
        return { ts: String(body["ts"] ?? ""), channel: String(body["channel"] ?? channel) };
      },
    }),

    listChannels: createAction({
      summary: "List channels the token can see.",
      useCases: ["list channels", "find a channel", "what channels exist"],
      sideEffects: "read",
      input: z.object({
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional().describe("Page cursor from a previous call."),
      }),
      output: z.object({
        channels: z.array(z.object({ id: z.string(), name: z.string(), isPrivate: z.boolean() })),
        cursor: z.string().optional(),
      }),
      example: "{ limit: 50 }",
      handler: async ({ limit = 100, cursor }, context) => {
        const body = await context.http.get("conversations.list", {
          query: { limit, cursor },
        });
        const channels = (body["channels"] as Array<Record<string, unknown>> | undefined) ?? [];
        const next = (body["response_metadata"] as { next_cursor?: string } | undefined)
          ?.next_cursor;
        return {
          channels: channels.map((channel) => ({
            id: String(channel["id"]),
            name: String(channel["name"]),
            isPrivate: Boolean(channel["is_private"]),
          })),
          ...(next ? { cursor: next } : {}),
        };
      },
    }),

    searchMessages: createAction({
      summary: "Search message history by text.",
      useCases: ["search messages", "find a conversation", "what was said about"],
      sideEffects: "read",
      input: z.object({
        query: z.string().describe("Slack search syntax, e.g. 'deploy in:#eng'."),
        count: z.number().int().min(1).max(100).optional(),
      }),
      output: z.object({
        matches: z.array(
          z.object({
            channel: z.string(),
            user: z.string(),
            text: z.string(),
            ts: z.string(),
          }),
        ),
      }),
      example: '{ query: "incident in:#eng" }',
      handler: async ({ query, count = 20 }, context) => {
        const body = await context.http.get("search.messages", {
          query: { query, count },
        });
        const matches =
          (body["messages"] as { matches?: Array<Record<string, unknown>> } | undefined)?.matches ??
          [];
        return {
          matches: matches.map((match) => ({
            channel: String((match["channel"] as { name?: string } | undefined)?.name ?? ""),
            user: String(match["username"] ?? match["user"] ?? ""),
            text: String(match["text"] ?? ""),
            ts: String(match["ts"] ?? ""),
          })),
        };
      },
    }),

    getThread: createAction({
      summary: "Fetch every reply in a message thread.",
      useCases: ["read a thread", "get replies", "catch up on a conversation"],
      sideEffects: "read",
      input: z.object({
        channel: z.string().describe("Channel id the thread lives in."),
        threadTs: z.string().describe("Timestamp of the thread's first message."),
      }),
      output: z.object({
        messages: z.array(z.object({ user: z.string(), text: z.string(), ts: z.string() })),
      }),
      example: '{ channel: "C123", threadTs: "1700000000.000100" }',
      handler: async ({ channel, threadTs }, context) => {
        const body = await context.http.get("conversations.replies", {
          query: { channel, ts: threadTs },
        });
        const messages = (body["messages"] as Array<Record<string, unknown>> | undefined) ?? [];
        return {
          messages: messages.map((message) => ({
            user: String(message["user"] ?? ""),
            text: String(message["text"] ?? ""),
            ts: String(message["ts"] ?? ""),
          })),
        };
      },
    }),
  },
});

/** What `slack(…)` takes: the auth scheme's input plus the options schema. */
export type SlackOptions = Parameters<typeof slack>[0];

/**
 * `new Slack({ apiKey })`, for callers who prefer it. It forwards to the
 * factory, so there is exactly one definition of what Slack is.
 */
export class Slack implements App {
  readonly #app: App;

  constructor(options: SlackOptions) {
    this.#app = slack(options);
  }

  get id(): string {
    return this.#app.id;
  }
  get name(): string {
    return this.#app.name;
  }
  get description(): string {
    return this.#app.description;
  }
  get allowedHosts(): readonly string[] {
    return this.#app.allowedHosts;
  }
  get http(): HttpConfig | undefined {
    return this.#app.http;
  }
  get auth(): App["auth"] {
    return this.#app.auth;
  }
  authorize(request: Request): Request {
    return this.#app.authorize(request);
  }
  actions() {
    return this.#app.actions();
  }
}
