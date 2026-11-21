import { z } from "zod";
import { createAction, createApp } from "@cloudfarm/core";
import type { App, ActionContext } from "@cloudfarm/core";

export interface SlackOptions {
  /**
   * A Slack bot or user token (`xoxb-…`). It is captured in the closure that
   * `authorize()` closes over; it is never passed to an action handler, put
   * in a result, or reachable from code mode.
   */
  readonly apiKey: string;
  /**
   * Override the API base, for a proxy or a test double. Its host is added to
   * the egress allowlist automatically — overriding the base is an explicit
   * act by the host application, unlike a URL arriving in a model's arguments.
   */
  readonly baseUrl?: string;
}

const BASE = "https://slack.com/api";

/**
 * Slack as an app plugin.
 *
 * Every action declares its own Zod schemas, which do four jobs at once:
 * they validate the model's arguments before anything runs, they type the
 * handler, they generate the JSON Schema a tool definition needs, and they
 * render the TypeScript the model writes against in code mode.
 */
export function slack(options: SlackOptions): App {
  if (!options.apiKey) throw new Error("Slack needs an apiKey (a bot token, xoxb-…)");
  const apiKey = options.apiKey;
  const base = options.baseUrl ?? BASE;

  const hosts = ["slack.com", "*.slack.com"];
  if (options.baseUrl) hosts.push(new URL(options.baseUrl).hostname);

  return createApp({
    id: "slack",
    name: "Slack",
    description:
      "Team messaging. Post messages to channels or DMs, list channels, read threads and search history.",
    /** A prompt-injected URL cannot redirect a credentialed request off this list. */
    allowedHosts: hosts,
    authorize: (request) => {
      const authorized = new Request(request);
      authorized.headers.set("authorization", `Bearer ${apiKey}`);
      return authorized;
    },
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
          channel: z
            .string()
            .describe('Channel name ("#general"), channel id, or user id for a DM.'),
          text: z.string().describe("Message text. Slack mrkdwn is supported."),
          threadTs: z.string().optional().describe("Reply inside an existing thread."),
        }),
        output: z.object({ ts: z.string(), channel: z.string() }),
        example: '{ channel: "#general", text: "deploy finished" }',
        handler: async ({ channel, text, threadTs }, context) => {
          const body = await post(context, `${base}/chat.postMessage`, {
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
          const url = new URL(`${base}/conversations.list`);
          url.searchParams.set("limit", String(limit));
          if (cursor) url.searchParams.set("cursor", cursor);

          const body = await get(context, url);
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
          const url = new URL(`${base}/search.messages`);
          url.searchParams.set("query", query);
          url.searchParams.set("count", String(count));

          const body = await get(context, url);
          const matches =
            (body["messages"] as { matches?: Array<Record<string, unknown>> } | undefined)
              ?.matches ?? [];
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
          const url = new URL(`${base}/conversations.replies`);
          url.searchParams.set("channel", channel);
          url.searchParams.set("ts", threadTs);

          const body = await get(context, url);
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
}

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
  authorize(request: Request): Request {
    return this.#app.authorize(request);
  }
  actions() {
    return this.#app.actions();
  }
}

// --- transport --------------------------------------------------------------

async function get(context: ActionContext, url: URL): Promise<Record<string, unknown>> {
  return unwrap(await context.fetch(url, { method: "GET" }));
}

async function post(
  context: ActionContext,
  url: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return unwrap(
    await context.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    }),
  );
}

/**
 * Slack answers 200 with `{ ok: false, error }` rather than an HTTP error, so
 * the body is the only reliable signal.
 */
async function unwrap(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`Slack returned HTTP ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (body["ok"] !== true) {
    throw new Error(`Slack rejected the request: ${String(body["error"] ?? "unknown_error")}`);
  }
  return body;
}
