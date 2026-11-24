import { z } from "zod";
import { apiKey, createAction, createApp, UpstreamRejectedError } from "@cloudfarm/computer";

const API = "https://api.firecrawl.dev/v2";

/**
 * Firecrawl as an app plugin.
 *
 * Its distinctive action is `search`: an agent that can only fetch URLs it
 * already knows is limited to what the task names. Search is how it finds the
 * page it needs in the first place, and Firecrawl returns results that can
 * carry the page content with them — one call instead of search-then-fetch.
 *
 * `scrape` overlaps with `web.read` from @cloudfarm/cloudflare-browser, and
 * that is fine: they are different vendors with different strengths, and the
 * registry lets a workspace install either, both, or neither.
 */
export const firecrawl = createApp({
  id: "firecrawl",
  name: "Firecrawl",
  description:
    "Search the web, read any page as markdown, and list every URL on a site. Renders JavaScript.",
  auth: apiKey({ describe: "A Firecrawl API key (fc-…)." }),
  options: z.object({
    baseUrl: z.string().url().optional().describe("Override the API base, for a test double."),
  }),
  allowedHosts: () => ["api.firecrawl.dev"],
  http: ({ baseUrl }) => ({
    baseUrl: baseUrl ?? API,
    /** Firecrawl answers 200 with `{ success: false, error }`. */
    validate: (body) => {
      const payload = body as { success?: boolean; error?: unknown };
      if (payload.success === false) {
        throw new UpstreamRejectedError(
          `Firecrawl rejected the request: ${String(payload.error ?? "unknown_error")}`,
        );
      }
    },
  }),

  actions: {
    search: createAction({
      summary: "Search the web and get back ranked results.",
      useCases: [
        "search the web",
        "find pages about a topic",
        "look something up online",
        "what is the latest on",
        "find the official documentation for",
      ],
      keywords: ["google", "lookup", "research", "find"],
      sideEffects: "read",
      input: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
        includeContent: z
          .boolean()
          .default(false)
          .describe(
            "Also scrape each result to markdown. One call instead of search-then-read, but slower and far larger.",
          ),
        maxCharsPerResult: z.number().int().min(200).max(50_000).default(4000),
      }),
      output: z.object({
        query: z.string(),
        results: z.array(
          z.object({
            title: z.string(),
            url: z.string(),
            description: z.string(),
            markdown: z.string().optional().describe("Only when includeContent was true."),
          }),
        ),
      }),
      example: '{ query: "cloudflare browser rendering pricing", limit: 5 }',
      handler: async ({ query, limit, includeContent, maxCharsPerResult }, context) => {
        const body = await context.http.post<{ data?: { web?: SearchHit[] } }>("search", {
          query,
          limit,
          sources: [{ type: "web" }],
          ...(includeContent
            ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }
            : {}),
        });

        return {
          query,
          results: (body.data?.web ?? []).map((hit) => {
            const result: SearchResult = {
              title: String(hit.title ?? ""),
              url: String(hit.url ?? ""),
              description: String(hit.description ?? ""),
            };
            // Scraped content is per-result, so a 10-result search with
            // content is ten pages at once. Each is capped separately.
            if (includeContent && typeof hit.markdown === "string") {
              result.markdown = clamp(hit.markdown, maxCharsPerResult);
            }
            return result;
          }),
        };
      },
    }),

    scrape: createAction({
      summary: "Read one page as markdown, with JavaScript rendered.",
      useCases: ["read a page", "fetch this url", "get the content of a link", "read an article"],
      keywords: ["url", "page", "markdown", "fetch"],
      sideEffects: "read",
      input: z.object({
        url: z.string().url(),
        onlyMainContent: z
          .boolean()
          .default(true)
          .describe("Strip navigation, footers and boilerplate."),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(200_000)
          .default(20_000)
          .describe("Longer pages are parked in the workspace and reported by reference."),
      }),
      output: z.object({
        url: z.string(),
        title: z.string(),
        markdown: z.string(),
        truncated: z.object({ ref: z.string(), totalChars: z.number() }).optional(),
      }),
      example: '{ url: "https://docs.firecrawl.dev" }',
      handler: async ({ url, onlyMainContent, maxChars }, context) => {
        const body = await context.http.post<{ data?: ScrapeData }>("scrape", {
          url,
          formats: ["markdown"],
          onlyMainContent,
        });

        const markdown = String(body.data?.markdown ?? "");
        const title = String(body.data?.metadata?.title ?? "");

        if (markdown.length > maxChars) {
          const ref = await context.ref(markdown, "text/markdown");
          return {
            url,
            title,
            markdown: markdown.slice(0, maxChars),
            truncated: { ref: ref.$ref, totalChars: markdown.length },
          };
        }
        return { url, title, markdown };
      },
    }),

    map: createAction({
      summary: "List the URLs on a site, without reading each page.",
      useCases: [
        "list every page on a site",
        "find the url for a section",
        "what pages does this site have",
        "map a documentation site",
      ],
      keywords: ["sitemap", "urls", "discover", "index"],
      sideEffects: "read",
      input: z.object({
        url: z.string().url(),
        search: z
          .string()
          .optional()
          .describe("Keep only URLs matching this term — much smaller than the whole map."),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      output: z.object({ url: z.string(), links: z.array(z.string()) }),
      example: '{ url: "https://docs.firecrawl.dev", search: "pricing" }',
      handler: async ({ url, search, limit }, context) => {
        const body = await context.http.post<{ links?: unknown[] }>("map", {
          url,
          ...(search ? { search } : {}),
          limit,
        });

        return {
          url,
          // v1 returned bare strings and v2 returns objects; accept either
          // rather than break the day the account moves between them.
          links: (body.links ?? [])
            .map((link) =>
              typeof link === "string" ? link : String((link as { url?: unknown }).url ?? ""),
            )
            .filter(Boolean)
            .slice(0, limit),
        };
      },
    }),
  },
});

interface SearchHit {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  markdown?: unknown;
}

interface SearchResult {
  title: string;
  url: string;
  description: string;
  markdown?: string;
}

interface ScrapeData {
  markdown?: unknown;
  metadata?: { title?: unknown };
}

/** Marks the cut, so a model knows the text ended early rather than there. */
function clamp(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n\n…[truncated]` : text;
}
