import { z } from "zod";
import { apiKey, createAction, createApp, UpstreamRejectedError } from "@cloudfarm/computer";
import type { ActionContext } from "@cloudfarm/computer";

const API = "https://api.cloudflare.com/client/v4";

/**
 * The open web, via Cloudflare Browser Run.
 *
 * A real browser renders the page — JavaScript included — but there is no
 * session to hold open: every action is one HTTPS request that returns
 * content. That is the whole reason to start here rather than with a
 * CDP-over-WebSocket driver. It works unchanged on Node and Workers, nothing
 * bills while idle, and it covers the case agents actually hit most: *read*
 * this page.
 *
 * What it deliberately does not do is click, type, or carry state across
 * calls. That is a stateful browser session, a different thing, and the
 * `browser` namespace is reserved for it. This app is `web`, which is also
 * what a model would call it.
 */
export const web = createApp({
  id: "web",
  name: "Web",
  description:
    "Read pages from the open web. Renders JavaScript, returns markdown, extracts elements by CSS selector, lists links, and captures screenshots.",
  icon: "https://cdn.simpleicons.org/cloudflare",
  auth: apiKey({
    describe: "A Cloudflare API token with the 'Browser Run - Edit' permission.",
  }),
  options: z.object({
    accountId: z.string().min(1).describe("Cloudflare account id; it is part of the URL."),
    baseUrl: z.string().url().optional().describe("Override the API base, for a test double."),
  }),
  allowedHosts: () => ["api.cloudflare.com"],
  http: ({ accountId, baseUrl }) => ({
    baseUrl: `${baseUrl ?? API}/accounts/${accountId}/browser-run`,
    /** Cloudflare answers 200 with `{ success: false, errors }`. */
    validate: (body) => {
      const payload = body as { success?: boolean; errors?: { message?: string }[] };
      if (payload.success === false) {
        const reason = payload.errors?.map((error) => error.message).join("; ") ?? "unknown_error";
        throw new UpstreamRejectedError(`Cloudflare Browser Run rejected the request: ${reason}`);
      }
    },
  }),

  actions: {
    read: createAction({
      summary: "Read a web page as markdown, with JavaScript rendered.",
      useCases: [
        "read a web page",
        "what does this url say",
        "fetch an article",
        "summarise a page",
        "get the content behind a link",
      ],
      keywords: ["url", "page", "markdown", "article", "website"],
      sideEffects: "read",
      input: z.object({
        url: z.string().url(),
        waitForSelector: z
          .string()
          .optional()
          .describe(
            "Wait for this CSS selector before reading. Faster than waiting for the network.",
          ),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
          .optional()
          .describe("Use networkidle0 for single-page apps that render late."),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(200_000)
          .default(20_000)
          .describe("Longer pages are parked in the workspace and summarised by a pointer."),
      }),
      output: z.object({
        url: z.string(),
        markdown: z.string(),
        truncated: z
          .object({ ref: z.string(), totalChars: z.number() })
          .optional()
          .describe("Present when the page did not fit; read this path for the rest."),
      }),
      example: '{ url: "https://example.com" }',
      handler: async ({ url, waitForSelector, waitUntil, maxChars }, context) => {
        const body = await context.http.post<{ result?: string }>("markdown", {
          url,
          ...(waitForSelector ? { waitForSelector } : {}),
          ...(waitUntil ? { gotoOptions: { waitUntil } } : {}),
        });
        const markdown = String(body.result ?? "");

        // A long page would otherwise flow straight into the context window.
        // Park it and hand back a pointer: the agent can read the file if the
        // head is not enough.
        if (markdown.length > maxChars) {
          const ref = await context.ref(markdown, "text/markdown");
          return {
            url,
            markdown: markdown.slice(0, maxChars),
            truncated: { ref: ref.$ref, totalChars: markdown.length },
          };
        }
        return { url, markdown };
      },
    }),

    scrape: createAction({
      summary: "Extract elements from a page by CSS selector.",
      useCases: [
        "extract prices from a page",
        "get every heading",
        "pull a table out of a page",
        "scrape specific elements",
      ],
      keywords: ["selector", "extract", "css", "elements"],
      sideEffects: "read",
      input: z.object({
        url: z.string().url(),
        selectors: z.array(z.string()).min(1).describe('CSS selectors, e.g. ["h1", "a.product"].'),
        waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(),
      }),
      output: z.object({
        url: z.string(),
        elements: z.array(
          z.object({
            selector: z.string(),
            matches: z.array(
              z.object({
                text: z.string(),
                attributes: z.record(z.string(), z.string()),
              }),
            ),
          }),
        ),
      }),
      example: '{ url: "https://example.com", selectors: ["h1", "a"] }',
      handler: async ({ url, selectors, waitUntil }, context) => {
        const body = await context.http.post<{ result?: ScrapeResult[] }>("scrape", {
          url,
          elements: selectors.map((selector) => ({ selector })),
          ...(waitUntil ? { gotoOptions: { waitUntil } } : {}),
        });

        return {
          url,
          elements: (body.result ?? []).map((group) => ({
            selector: String(group.selector ?? ""),
            // Geometry (top/left/width/height) and inner HTML are dropped:
            // they are most of the payload and a model rarely needs either.
            matches: (group.results ?? []).map((match) => ({
              text: String(match.text ?? ""),
              attributes: Object.fromEntries(
                (match.attributes ?? []).map((attribute) => [
                  String(attribute.name),
                  String(attribute.value),
                ]),
              ),
            })),
          })),
        };
      },
    }),

    links: createAction({
      summary: "List the links on a page.",
      useCases: ["list the links on a page", "find where a page points", "what can I click here"],
      sideEffects: "read",
      input: z.object({
        url: z.string().url(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      output: z.object({ url: z.string(), links: z.array(z.string()) }),
      example: '{ url: "https://example.com" }',
      handler: async ({ url, limit }, context) => {
        const body = await context.http.post<{ result?: unknown[] }>("links", { url });
        const links = (body.result ?? [])
          // The endpoint has returned both bare strings and {url} objects;
          // accept either rather than break on a shape change.
          .map((link) =>
            typeof link === "string" ? link : String((link as { url?: unknown }).url ?? ""),
          )
          .filter(Boolean)
          .slice(0, limit);

        return { url, links };
      },
    }),

    screenshot: createAction({
      summary: "Capture a screenshot of a page, saved into the workspace.",
      useCases: [
        "take a screenshot",
        "capture a page as an image",
        "what does this page look like",
      ],
      keywords: ["image", "png", "capture", "visual"],
      sideEffects: "read",
      input: z.object({
        url: z.string().url(),
        fullPage: z.boolean().default(false),
        selector: z.string().optional().describe("Capture one element instead of the page."),
        width: z.number().int().min(320).max(3840).default(1280),
        height: z.number().int().min(240).max(2160).default(720),
      }),
      output: z.object({
        url: z.string(),
        ref: z.string().describe("Where the image was written in the workspace."),
        bytes: z.number(),
      }),
      example: '{ url: "https://example.com", fullPage: true }',
      handler: async ({ url, fullPage, selector, width, height }, context) => {
        // PNG bytes, not JSON, so this uses the client's raw escape hatch:
        // same base URL and same credential, no parsing.
        const image = await capture(context, {
          url,
          screenshotOptions: { fullPage },
          viewport: { width, height },
          ...(selector ? { selector } : {}),
        });

        // An image can never go inline into a context window, so it is parked
        // in the workspace and reported by path.
        const ref = await context.ref(image, "image/png");
        return { url, ref: ref.$ref, bytes: image.byteLength };
      },
    }),
  },
});

interface ScrapeResult {
  selector?: unknown;
  results?: {
    text?: unknown;
    attributes?: { name?: unknown; value?: unknown }[];
  }[];
}

async function capture(context: ActionContext, payload: unknown): Promise<Uint8Array> {
  const response = await context.http.raw("screenshot", { method: "POST", body: payload });

  if (!response.ok) {
    throw new UpstreamRejectedError(
      `Cloudflare Browser Run returned HTTP ${response.status} for the screenshot.`,
    );
  }
  // A failure arrives as JSON even on this endpoint; bytes mean success.
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    const body = (await response.json()) as { errors?: { message?: string }[] };
    throw new UpstreamRejectedError(
      `Cloudflare Browser Run rejected the screenshot: ${
        body.errors?.map((error) => error.message).join("; ") ?? "unknown_error"
      }`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}
