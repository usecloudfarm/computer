import { z } from "zod";
import { createAction, createApp, noAuth } from "@cloudfarm/computer";
import type { ActionContext } from "@cloudfarm/computer";

const FIREBASE = "https://hacker-news.firebaseio.com/v0";
const ALGOLIA = "https://hn.algolia.com/api/v1";

/**
 * Hacker News as an app plugin.
 *
 * Two APIs behind one app, because neither is good at the other's job. The
 * official Firebase API is authoritative and current but has no search and no
 * batch read — a front page costs one request for the id list plus one per
 * story. Algolia indexes the whole archive and searches it in one request, but
 * lags a little and does not expose comment trees well. So: Firebase for
 * reading, Algolia for searching.
 *
 * `noAuth()` is the point of interest for anyone reading this as a template —
 * a public API still declares a scheme, so "no credentials" is a decision
 * rather than an omission.
 */
export const hackernews = createApp({
  id: "hackernews",
  name: "Hacker News",
  description:
    "Hacker News: read the front page, open a story's comments, search the archive, look up a user.",
  icon: "https://cdn.simpleicons.org/ycombinator",
  auth: noAuth(),
  // Firebase is the base; Algolia is reached by absolute URL, so its host has
  // to be declared or the egress guard blocks it.
  allowedHosts: ["hacker-news.firebaseio.com", "hn.algolia.com"],
  http: () => ({ baseUrl: FIREBASE }),

  actions: {
    topStories: createAction({
      summary: "Read the current front page, or another of Hacker News' lists.",
      useCases: [
        "what is on hacker news",
        "read the front page",
        "what is trending on hn",
        "show me ask hn",
        "show me show hn",
        "who is hiring",
      ],
      keywords: ["hn", "frontpage", "news", "trending"],
      sideEffects: "read",
      input: z.object({
        list: z
          .enum(["top", "new", "best", "ask", "show", "job"])
          .default("top")
          .describe("Which list to read. 'top' is the front page."),
        limit: z.number().int().min(1).max(30).default(10),
      }),
      output: z.object({ stories: z.array(Story()) }),
      example: '{ list: "top", limit: 10 }',
      handler: async ({ list, limit }, context) => {
        const ids = await context.http.get<number[]>(`${LISTS[list]}.json`);
        // One request per story: fan out on the host, where real concurrency
        // exists. (Inside code mode the guest is synchronous, but this is host
        // code — the distinction matters here.)
        const items = await Promise.all(ids.slice(0, limit).map((id) => item(context, id)));
        return { stories: items.filter(Boolean).map(toStory) };
      },
    }),

    getStory: createAction({
      summary: "Fetch one story by id, with its text if it has any.",
      useCases: ["open a story", "read this hn post", "get story details"],
      sideEffects: "read",
      input: z.object({ id: z.number().int().positive() }),
      output: Story(),
      example: "{ id: 8863 }",
      handler: async ({ id }, context) => {
        const story = await item(context, id);
        if (!story) throw new Error(`No Hacker News item with id ${id}.`);
        return toStory(story);
      },
    }),

    getComments: createAction({
      summary: "Read the top-level comments on a story.",
      useCases: [
        "what are people saying",
        "read the comments",
        "summarise the discussion",
        "what is the reaction",
      ],
      keywords: ["discussion", "replies", "thread"],
      sideEffects: "read",
      input: z.object({
        id: z.number().int().positive().describe("Story id."),
        limit: z.number().int().min(1).max(30).default(10),
      }),
      output: z.object({
        storyId: z.number(),
        comments: z.array(
          z.object({
            id: z.number(),
            by: z.string(),
            text: z.string(),
            replies: z.number().describe("How many direct replies this comment has."),
          }),
        ),
      }),
      example: "{ id: 8863, limit: 10 }",
      handler: async ({ id, limit }, context) => {
        const story = await item(context, id);
        const kids = (story?.["kids"] as number[] | undefined) ?? [];
        const loaded = await Promise.all(kids.slice(0, limit).map((kid) => item(context, kid)));

        return {
          storyId: id,
          comments: loaded
            .filter((comment) => comment && !comment["deleted"] && !comment["dead"])
            .map((comment) => ({
              id: Number(comment!["id"]),
              by: String(comment!["by"] ?? ""),
              // HN serves comment bodies as HTML. A model reading `&#x27;` and
              // `<p>` wastes context on markup it then has to ignore.
              text: toPlainText(String(comment!["text"] ?? "")),
              replies: ((comment!["kids"] as number[] | undefined) ?? []).length,
            })),
        };
      },
    }),

    search: createAction({
      summary: "Search the Hacker News archive by text.",
      useCases: [
        "has this been discussed before",
        "find past posts about a topic",
        "search the archive",
        "what was written about",
      ],
      keywords: ["find", "archive", "history"],
      sideEffects: "read",
      input: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(30).default(10),
        sortBy: z
          .enum(["relevance", "date"])
          .default("relevance")
          .describe("'date' returns the newest matches instead of the best ones."),
      }),
      output: z.object({
        hits: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            url: z.string().optional(),
            author: z.string(),
            points: z.number(),
            comments: z.number(),
            createdAt: z.string(),
          }),
        ),
      }),
      example: '{ query: "rust memory safety", limit: 10 }',
      handler: async ({ query, limit, sortBy }, context) => {
        const path = sortBy === "date" ? "search_by_date" : "search";
        const body = await context.http.get<{ hits?: Record<string, unknown>[] }>(
          `${ALGOLIA}/${path}`,
          { query: { query, tags: "story", hitsPerPage: limit } },
        );

        return {
          hits: (body.hits ?? []).map((hit) => {
            // `url` must be absent rather than undefined (an Ask HN post has
            // none), so it is assigned conditionally instead of spread in.
            const result: SearchHit = {
              id: Number(hit["objectID"]),
              title: String(hit["title"] ?? ""),
              author: String(hit["author"] ?? ""),
              points: Number(hit["points"] ?? 0),
              comments: Number(hit["num_comments"] ?? 0),
              createdAt: String(hit["created_at"] ?? ""),
            };
            if (hit["url"]) result.url = String(hit["url"]);
            return result;
          }),
        };
      },
    }),

    getUser: createAction({
      summary: "Look up a Hacker News user's karma and bio.",
      useCases: ["who is this user", "look up an hn account", "check someone's karma"],
      sideEffects: "read",
      input: z.object({ username: z.string().min(1) }),
      output: z.object({
        id: z.string(),
        karma: z.number(),
        about: z.string(),
        createdAt: z.number().describe("Unix seconds."),
        submissions: z.number(),
      }),
      example: '{ username: "pg" }',
      handler: async ({ username }, context) => {
        const user = await context.http.get<Record<string, unknown> | null>(
          `user/${encodeURIComponent(username)}.json`,
        );
        if (!user) throw new Error(`No Hacker News user called "${username}".`);
        return {
          id: String(user["id"]),
          karma: Number(user["karma"] ?? 0),
          about: toPlainText(String(user["about"] ?? "")),
          createdAt: Number(user["created"] ?? 0),
          submissions: ((user["submitted"] as number[] | undefined) ?? []).length,
        };
      },
    }),
  },
});

interface SearchHit {
  id: number;
  title: string;
  url?: string;
  author: string;
  points: number;
  comments: number;
  createdAt: string;
}

const LISTS = {
  top: "topstories",
  new: "newstories",
  best: "beststories",
  ask: "askstories",
  show: "showstories",
  job: "jobstories",
} as const;

/** The story shape, shared by the list and single-item actions. */
function Story() {
  return z.object({
    id: z.number(),
    title: z.string(),
    url: z.string().optional().describe("Absent for Ask HN and text posts."),
    by: z.string(),
    score: z.number(),
    comments: z.number(),
    time: z.number().describe("Unix seconds."),
    text: z.string().optional().describe("Body text, for Ask HN and similar."),
    hnUrl: z.string().describe("The discussion page, which a story url never points at."),
  });
}

async function item(context: ActionContext, id: number): Promise<Record<string, unknown> | null> {
  return context.http.get<Record<string, unknown> | null>(`item/${id}.json`);
}

function toStory(raw: Record<string, unknown> | null): Record<string, unknown> {
  const id = Number(raw?.["id"] ?? 0);
  return {
    id,
    title: String(raw?.["title"] ?? ""),
    ...(raw?.["url"] ? { url: String(raw["url"]) } : {}),
    by: String(raw?.["by"] ?? ""),
    score: Number(raw?.["score"] ?? 0),
    comments: Number(raw?.["descendants"] ?? 0),
    time: Number(raw?.["time"] ?? 0),
    ...(raw?.["text"] ? { text: toPlainText(String(raw["text"])) } : {}),
    hnUrl: `https://news.ycombinator.com/item?id=${id}`,
  };
}

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&#x27;": "'",
  "&#x2F;": "/",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

/**
 * HN serves user text as a small subset of HTML. Turning it into plain text is
 * not cosmetic: the markup is tokens the model pays for and then ignores, and
 * `&amp;` must be decoded last or it would re-introduce entities it just
 * decoded (`&amp;lt;` → `&lt;` → `<`).
 */
function toPlainText(html: string): string {
  let text = html
    .replace(/<p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>.*?<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "");
  for (const [entity, character] of Object.entries(ENTITIES)) {
    if (entity !== "&amp;") text = text.replaceAll(entity, character);
  }
  return text.replaceAll("&amp;", "&").trim();
}
